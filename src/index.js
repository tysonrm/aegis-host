/**
 * Handle options and start the service.
 * Options:
 *
 * - run as serverless function or as web server
 * - http or https
 * - authorized routes enabled or disabled (json web token)
 * - clustering enabled or disabled
 * - hot reload as rolling restart or module cache refresh
 */

'use strict'

require('dotenv').config()
require('regenerator-runtime')
const importFresh = require('import-fresh')

// aegis library
const { adapters, services } = require('@module-federation/aegis')
const { AuthorizationService, CertificateService, ClusterService } = services
const { ServerlessAdapter, ServiceMeshAdapter } = adapters

const fs = require('fs')
const tls = require('tls')
const http = require('http')
const https = require('https')
const express = require('express')
const websocket = require('ws')

const port = process.argv[2] ? process.argv[2] : process.env.PORT || 80
const sslPort = process.argv[2] ? process.argv[2] : process.env.SSL_PORT || 443
const apiRoot = process.env.API_ROOT || '/microlib/api'
const keyFile = 'cert/privatekey.pem'
const certFile = 'cert/certificate.pem'
const forceTimeout = 3000 // time to wait for conn to drop before closing server
const certLoadPath = process.env.CERTLOAD_PATH || '/microlib/load-cert'
const hotReloadPath = process.env.HOTRELOAD_PATH || '/microlib/reload'
const cloudProvider = process.env.CLOUDPROVIDER || 'aws'
const clusterEnabled = /true/i.test(process.env.CLUSTER_ENABLED)
const checkIpHostname = process.env.CHECKIPHOST || 'checkip.amazonaws.com'
const domain = require('../public/aegis.config.json').general.fqdn || process.env.DOMAIN
const sslEnabled = // required in production
  /prod/i.test(process.env.NODE_ENV) || /true/i.test(process.env.SSL_ENABLED)

// enable authorization if selected
/**@type {express.Application} */
const app = AuthorizationService.protectRoutes(express(), '/microlib')

function isServerless() {
  return (
    /true/i.test(process.env.SERVERLESS) || /serverless/i.test(process.title)
  )
}

/**
 * Callbacks attached to existing routes are stale.
 * Clear the routes whose controllers we need to update.
 */
function clearRoutes() {
  app._router.stack = app._router.stack.filter(
    k => !(k && k.route && k.route.path && k.route.path.startsWith(apiRoot))
  )
}

/**
 * Load federated server module bundle, the bundle we self-expose. (We
 * never load main.js). Call `clear` to delete non-webpack cache if hot
 * reloading. Call `start` and return the `invoke` method, which calls
 * the server's controllers directly, for running as a serverless function.
 *
 * Note:
 *
 * About hot reload cache purge: even though we will have just loaded a fresh
 * copy of remoteEntry.js, because the runtime only loads each module once and
 * subsequent imports don't bypass the cache, those imports won't be fresh and
 * will need to be purged. We do not cache remoteEntry.js itself, so of course
 * the old copy won't be purged, but it _will_ eventually be garbage collected
 * since nothing will point to it after this.
 *
 * @param {{hot:boolean, serverless:boolean}} options If `hot` is true, reload;
 * if this is a serverless function call, set `serverless` to true.
 */
async function startMicroLib({ hot = false, serverless = false } = {}) {
  const remoteEntry = importFresh('./remoteEntry') // do not cache
  const factory = await remoteEntry.microlib.get('./server')
  const serverModule = factory()
  if (hot) {
    // clear stale routes
    clearRoutes()
    // clear cache on hot reload, see above.
    serverModule.default.clear()
  }
  // import and run remote service components
  await serverModule.default.start(app, serverless)
  // `invoke` calls the server's controllers directly
  return serverModule.default.invoke
}

/**
 * Handle hot reload requests. If running in cluster mode,
 * do a rolling restart instead of memory purge.
 */
function reloadCallback() {
  // Manual reset if left in wrong state
  app.use(`${hotReloadPath}-reset`, function (_req, res) {
    process.send({ cmd: 'reload-reset' })
    res.send('reload status reset...try again')
  })

  if (clusterEnabled) {
    app.use(hotReloadPath, async function (_req, res) {
      res.send('<h1>starting cluster reload</h1>')
      process.send({ cmd: 'reload' })
    })
    return
  }

  app.use(hotReloadPath, async function (_req, res) {
    try {
      // restart microlib
      await startMicroLib({ hot: true })
      res.send('<h1>hot reload complete</h1>')
    } catch (error) {
      console.error(error)
    }
  })
}

const greeting = (proto, host, port) =>
  `\n 🌎 ÆGIS listening on ${proto}://${host}:${port} \n`

/**
 * Ping a public server for our public address.
 */
function checkPublicIpAddress() {
  const bytes = []
  if (!/local/i.test(process.env.NODE_ENV)) {
    try {
      http.get(
        {
          hostname: checkIpHostname,
          method: 'get'
        },
        response => {
          response.on('data', chunk => bytes.push(chunk))
          response.on('end', function () {
            const ipAddr = bytes.join('').trim()
            console.log(greeting('http', ipAddr, port))
          })
        }
      )
      return
    } catch (e) {
      console.error('checkip', e.message)
    }
  } else {
    console.log(greeting('http', 'localhost', port))
  }
}

/**
 * Shutdown gracefully. Return 503 during shutdown to prevent new connections
 * @param {*} server
 * @param {*} [options]
 * @returns
 */
function shutdown(server) {
  let shuttingDown = false
  const devTimeout = 3000

  // Graceful shutdown taken from: http://blog.argteam.com/
  process.on('SIGTERM', () => {
    // shorter timeout in dev
    const timeout = !/^prod.*/i.test(process.env.NODE_ENV)
      ? devTimeout
      : forceTimeout

    if (shuttingDown) return
    shuttingDown = true
    console.info('Received kill signal (SIGTERM), shutting down')

    setTimeout(function () {
      console.error(
        'Taking too long to close connections, forcefully shutting down'
      )
      process.exit(1)
    }, timeout).unref()

    server.close(function () {
      console.info('Closed out remaining connections.')
      process.exit()
    })
  })

  function middleware(req, res, next) {
    if (!shuttingDown) return next()
    res.set('Connection', 'close')
    res.status(503).send('Server is in the process of restarting.')
  }

  return middleware
}

/**
 * Attach {@link ServiceMeshAdapter} to the API listener socket.
 * Listen for upgrade events from http server and switch
 * client to WebSockets protocol. Clients connecting this
 * way are using the service mesh, not the REST API. Use
 * key + cert in {@link secureCtx} for secure connection.
 *
 * @param {https.Server|http.Server} server
 * @param {tls.SecureContext} [secureCtx] if ssl enabled
 */
function attachServiceMesh(server, secureCtx = {}) {
  const wss = new websocket.Server({
    ...secureCtx,
    clientTracking: true,
    server: server,
    maxPayload: 104857600
  })
  wss.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, function (ws) {
      wss.emit('connection', ws, request)
    })
  })
  ServiceMeshAdapter.attachServer(wss)
}

/**
 * Programmatically provision CA cert using RFC
 * https://datatracker.ietf.org/doc/html/rfc8555
 *
 * {@link CertificateService} kicks off automated
 * id challenge test, conducted by the issuing CA.
 * If test passes or if cert already exists, hand
 * back the cert and private key.
 *
 * @param {string} domain domain for which cert will be  created
 * @param {boolean} [renewal] false by default, set true to renew
 * @returns
 */
async function requestTrustedCert(domain, renewal = false) {
  if (!renewal && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return {
      key: fs.readFileSync(keyFile, 'utf8'),
      cert: fs.readFileSync(certFile, 'utf-8')
    }
  }

  // call service to acquire or renew x509 certificate from PKI
  const { key, cert } = await CertificateService.provisionCert(domain)

  fs.writeFileSync(certFile, cert, 'utf-8')
  fs.writeFileSync(keyFile, key, 'utf-8')

  return { key, cert }
}

/**
 * redirect (from 80) to secure port (443)?
 */
let redirect = true

/**
 * Using {@link tls.createSecureContext} to create/renew
 * certs without restarting the server
 *
 * @param {boolean} renewal
 * @returns
 */
async function createSecureContext(renewal = false) {
  // turn off redirect
  redirect = false
  // get cert
  const cert = await requestTrustedCert(domain, renewal)
  // turn redirect back on
  redirect = true
  // return cert and key
  return tls.createSecureContext(cert)
}

/**
 * Listen on unsecured port (80). Redirect
 * to secure port (443) if SSL is enabled.
 * Don't redirect while cert challenge is
 * in progress. Challenge requires port 80
 */
async function startHttpServer() {
  const httpServer = http.createServer(app)
  app.use(shutdown(httpServer))

  if (sslEnabled) {
    /**
     * if {@link redirect} is true, redirect
     * all requests for http to https port
     */
    app.use(function (req, res) {
      if (redirect && req.protocol === 'http:') {
        const redirectUrl = `https://${domain}:${sslPort}${req.url}`
        res.redirect(301, redirectUrl)
      }
    })
  } else {
    // https disabled, so attach to http
    attachServiceMesh(httpServer)
  }
  httpServer.listen(port, checkPublicIpAddress)
}

/** the current cert/key pair */
let secureCtx

/**
 * Start the web server. Programmatically
 * provision CA cert if SSL (TLS) is enabled
 * and no cert is found in /cert directory.
 */
async function startWebServer() {
  startHttpServer()

  if (sslEnabled) {
    // provision or renew cert and key
    secureCtx = await createSecureContext()
    /**
     * provide cert via {@link secureCtx} - provision &
     * renew certs without having to restart the server
     */
    const httpsServer = https.createServer(
      {
        SNICallback: (_, cb) => cb(null, secureCtx)
      },
      app
    )
    // update secureCtx to refresh certificate
    app.use(
      certLoadPath,
      async () => (secureCtx = await createSecureContext(true))
    )
    // graceful shutdown prevents new clients from connecting
    app.use(shutdown(httpsServer))
    // service mesh uses same port
    attachServiceMesh(httpsServer, secureCtx)

    // listen on ssl port
    httpsServer.listen(sslPort, () =>
      console.info(greeting('https', domain, sslPort))
    )
  }
}

/**
 * start microlib and the webserver
 *
 * this function isn't called if running in serverless mode
 */
async function startService() {
  try {
    app.use(express.json())
    app.use(express.static('public'))
    await startMicroLib()
    reloadCallback()
    startWebServer()
  } catch (e) {
    console.error(startService.name, e)
  }
}

/**
 * Start a single instance or a cluster
 */
if (!isServerless()) {
  if (clusterEnabled) {
    // Fork child processes (one per core),
    // which share socket descriptor (round-robin)
    ClusterService.startCluster(startService)
  } else {
    startService()
  }
}

let serverlessAdapter

/**
 * Start as a serverless function - express does not run.
 * @param  {...any} args - payload passed to serverless function
 */
exports.handleServerlessRequest = async function (...args) {
  console.info('serverless function called', args)
  if (!serverlessAdapter) {
    serverlessAdapter = await ServerlessAdapter(
      () => startMicroLib({ serverless: true }),
      cloudProvider
    )
  }
  return serverlessAdapter.invokeController(...args)
}

// const fileHandler = new StaticFileHandler('public')

/**
 * Serve static files, i.e. the demo app.
 * @param {*} event
 * @param {*} context
 * @returns
 */
// exports.serveHtml = async (event, context) => {
//   console.debug({ event, context })
//   console.log(event.path)
//   event.path = 'index.html'
//   return fileHandler.get(event, context)
// }
