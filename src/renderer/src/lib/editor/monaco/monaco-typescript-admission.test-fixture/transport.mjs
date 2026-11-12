import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(`${process.cwd()}/package.json`)
const native = (path) => import(pathToFileURL(require.resolve(`monaco-editor/esm/vs/${path}`)))
let editor
export function bindEditor(api) {
  editor = api
}
const { TypeScriptWorker } = await native('language/typescript/tsWorker.js')
const { WorkerTextModelSyncClient, WorkerTextModelSyncServer } = await native(
  'editor/common/services/textModelSync/textModelSync.impl.js'
)

export const trace = { phase: 'creation', admissions: [], sync: [], methods: [], transports: [] }
export const pending = new Set()
export function observe(promise) {
  pending.add(promise)
  // Both outcomes remove the obligation; the original caller still receives its rejection.
  promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise)
  )
  return promise
}

export function createWebWorker(options) {
  if (options.moduleId !== 'vs/language/typescript/tsWorker') {
    throw new Error(`Unexpected transport: ${options.moduleId}`)
  }
  const server = new WorkerTextModelSyncServer()
  const worker = new TypeScriptWorker(
    { getMirrorModels: () => server.getModels() },
    options.createData
  )
  const forwarding = {
    $acceptNewModel(data) {
      trace.sync.push({ phase: trace.phase, kind: 'new', uri: data.url, version: data.versionId })
      server.$acceptNewModel(data)
    },
    $acceptModelChanged(uri, event) {
      trace.sync.push({ phase: trace.phase, kind: 'change', uri, version: event.versionId })
      server.$acceptModelChanged(uri, event)
    },
    $acceptRemovedModel(uri) {
      trace.sync.push({ phase: trace.phase, kind: 'remove', uri })
      server.$acceptRemovedModel(uri)
    }
  }
  const sync = new WorkerTextModelSyncClient(
    forwarding,
    { getModel: editor.getModel },
    options.keepIdleModels
  )
  const proxy = new Proxy(worker, {
    get(target, key) {
      if (key === 'then') {
        return undefined
      }
      const value = target[key]
      if (typeof value !== 'function') {
        return value
      }
      return (...args) => {
        trace.methods.push({
          phase: trace.phase,
          method: key,
          uri: typeof args[0] === 'string' ? args[0] : null
        })
        return observe(Promise.resolve().then(() => value.apply(target, args)))
      }
    }
  })
  let disposed = false
  const transport = {
    label: options.label,
    keepIdleModels: options.keepIdleModels,
    mirrors: () =>
      server.getModels().map((model) => ({ uri: model.uri.toString(), version: model.version })),
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      sync.dispose()
      worker.getLanguageService().dispose()
    }
  }
  trace.transports.push(transport)
  return {
    dispose: () => transport.dispose(),
    getProxy: () => Promise.resolve(proxy),
    async withSyncedResources(resources) {
      trace.admissions.push({ phase: trace.phase, uris: resources.map(String) })
      // Native client owns eligibility, initial copy, content forwarding and model retirement.
      sync.ensureSyncedResources(resources)
      return proxy
    }
  }
}
