'use strict'

require('regenerator-runtime')
const { domain, adapters } = require('@module-federation/aegis')
const { workerData, parentPort } = require('worker_threads')
const remote = require('../dist/remoteEntry')

const { importRemotes, EventBrokerFactory } = domain
const { initCache } = adapters.controllers
const DomainPorts = domain.UseCaseService
const modelName = workerData.poolName.toUpperCase()

if (!modelName) {
  console.error('no modelName specified!')
  process.exit(1)
}

/** @type {import('@module-federation/aegis/lib/domain/event-broker').EventBroker} */
const broker = EventBrokerFactory.getInstance()

/** @type {Promise<import('../webpack/remote-entries-type').remoteEntry[]>} */
const remoteEntries = remote.get('./remoteEntries').then(factory => factory())

const AppError = err => ({
  name: err.name,
  message: err.message,
  stack: err.stack,
  hasError: true
})

/**
 * Import and bind remote modules: i.e. models, adapters and services
 * @param {import('../webpack/remote-entries-type.js').remoteEntry[]} remotes
 * @returns
 */
async function init (remotes) {
  try {
    // import federated modules; override as needed
    await importRemotes(remotes)
    // get the inbound ports for this domain model
    return DomainPorts(modelName)
  } catch (error) {
    console.error({ fn: init.name, error })
  }
}

/**
 * Create a subchannel between this thread and the main thread that is dedicated
 * to events, both inter-thread (raised by one thread and handled by another) and
 * inter-process (remotely generated and locally handled or vice versa). Inter-process
 * events (event from another host instance) are transmitted over the service mesh.
 * Custom user-defined events will also use this channel.
 *
 * Connect both ends of the channel to the thread-local {@link broker} via pub & sub events.
 *
 * Unlike the main channel, the event channel is not meant to return a response to the caller.
 * If a response is needed, call `ThreadPool.run` as shown below.
 *
 * ```js
 * ThreadPool.runJob(jobName, jobData, { channel: EVENTCHANNEL })
 * ```
 *
 * @param {MessagePort} eventPort
 */
function connectEventChannel (eventPort) {
  try {
    // fire events from main
    eventPort.onmessage = async msgEvent =>
      broker.notify(msgEvent.data.eventName, msgEvent.data)

    // forward events to main
    broker.on('to_main', event =>
      eventPort.postMessage(JSON.parse(JSON.stringify(event)))
    )
  } catch (error) {
    console.error({ fn: connectEventChannel.name, error })
  }
}

remoteEntries.then(remotes => {
  init(remotes).then(async domainPorts => {
    console.info('aegis worker thread running')
    // load distributed cache and register its events
    await initCache().load()

    // handle API requests from main
    parentPort.on('message', async message => {
      // Look for a use case function called `message.name`
      if (typeof domainPorts[message.name] === 'function') {
        try {
          // invoke an inbound port method on this domain model
          const result = await domainPorts[message.name](message.data)
          // serialize `result` to get rid of any functions
          parentPort.postMessage(JSON.parse(JSON.stringify(result)))
        } catch (error) {
          // catch and return (dont kill the thread)
          parentPort.postMessage(AppError(error))
        }
        // The "event port" is transfered
      } else if (message.eventPort instanceof MessagePort) {
        // send/recv events to/from main thread
        connectEventChannel(message.eventPort)
        // no response expected
      } else if (message.name === 'ping') {
        parentPort.postMessage('pong')
      } else {
        console.warn('not a domain port', message)
        // main is expecting a response
        parentPort.postMessage(
          AppError(new Error(`not a function: ${message}`))
        )
      }
    })
    parentPort.on('close', () => console.log('close'))

    parentPort.on('messageerror', err => console.error(err))
  })
})
