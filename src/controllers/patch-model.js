import log from '../lib/logger';
import Model from '../models/model';

export default function patchModelFactory(editModel) {
  return async function patchModel(httpRequest) {
    try {
      const { source = {}, ...modelInfo } = httpRequest.body
      log({ function: 'patchModel', ...modelInfo });

      source.ip = httpRequest.ip
      source.browser = httpRequest.headers['User-Agent']
      if (httpRequest.headers['Referer']) {
        source.referrer = httpRequest.headers['Referer']
      }
      log(source);
      const id = httpRequest.params.id;

      const model = await editModel(id, { ...modelInfo });
      log({ function: editModel.name, modelData: { ...model } });

      return {
        headers: {
          'Content-Type': 'application/json',
          'Last-Modified': new Date().toUTCString()
        },
        statusCode: 201,
        body: { modelId: model[Model.getKey('id')] }
      }
    } catch (e) {
      log(e);

      return {
        headers: {
          'Content-Type': 'application/json'
        },
        statusCode: 400,
        body: {
          error: e.message
        }
      }
    }
  }
}
