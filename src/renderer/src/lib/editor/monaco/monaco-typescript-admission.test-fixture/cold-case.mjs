import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as deadline, clearTimeout as clearDeadline } from 'node:timers'

const require = createRequire(`${process.cwd()}/package.json`)
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')))
const window = new Window({
  url: 'http://localhost/',
  width: 1200,
  height: 800,
  settings: { disableErrorCapturing: true }
})
for (const key of Object.getOwnPropertyNames(window)) {
  if (
    !(key in globalThis) ||
    ['Event', 'EventTarget', 'CustomEvent', 'MessageEvent'].includes(key)
  ) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key]
    })
  }
}
for (const key of [
  'window',
  'self',
  'document',
  'navigator',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval'
]) {
  const value = key === 'self' || key === 'window' ? window : window[key]
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: typeof value === 'function' ? value.bind(window) : value
  })
}
// Happy DOM has no font layout; prevent native zero-width font retry loops, not provider work.
const nativeWidth = Object.getOwnPropertyDescriptor(
  window.HTMLElement.prototype,
  'offsetWidth'
)?.get
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    if (this.tagName === 'SPAN' && this.parentElement?.parentElement?.style.top === '-50000px') {
      return this.textContent.length * 7
    }
    return nativeWidth?.call(this) ?? 0
  }
})
if (!window.requestIdleCallback) {
  window.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 15 }), 0)
  window.cancelIdleCallback = (id) => window.clearTimeout(id)
}
// No raster assertions: this DOM-only metric surface leaves language results entirely native.
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy(
    {
      canvas: this,
      measureText: (text) => ({ width: text.length * 7 }),
      createImageData: (width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
      }),
      getImageData: (_x, _y, width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
      })
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) }
  )
}
// Wait for real finite scheduled tasks, not permanent native worker-idle intervals.
const scheduled = new Set()
const scheduledDetails = new Map()
for (const [schedule, cancel] of [
  ['setTimeout', 'clearTimeout'],
  ['requestAnimationFrame', 'cancelAnimationFrame'],
  ['requestIdleCallback', 'cancelIdleCallback']
]) {
  if (typeof window[schedule] !== 'function') {
    continue
  }
  const start = window[schedule].bind(window)
  const stop = window[cancel].bind(window)
  const obligations = new Map()
  window[schedule] = (callback, ...args) => {
    let complete
    const task = new Promise((resolve) => {
      complete = resolve
    })
    scheduled.add(task)
    scheduledDetails.set(task, {
      schedule,
      delay: args[0],
      stack: new Error('Native scheduled task provenance').stack
    })
    let id
    const finish = () => {
      obligations.delete(id)
      scheduled.delete(task)
      scheduledDetails.delete(task)
      complete()
    }
    id = start(
      (...values) => {
        try {
          return callback(...values)
        } finally {
          finish()
        }
      },
      ...args
    )
    obligations.set(id, finish)
    return id
  }
  window[cancel] = (id) => {
    stop(id)
    obligations.get(id)?.()
  }
  globalThis[schedule] = window[schedule]
  globalThis[cancel] = window[cancel]
}
const native = (path) => import(pathToFileURL(require.resolve(`monaco-editor/esm/vs/${path}`)))
const errors = []
const warnings = []
let creatingRetainedModels = false
const { errorHandler } = await native('base/common/errors.js')
const { ListenerLeakError } = await native('base/common/event.js')
errorHandler.unexpectedErrorHandler = (error) => {
  const stack = String(error?.stack ?? error)
  // Native live-model fanout heuristic; other emitters/phases remain operation failures.
  if (
    creatingRetainedModels &&
    error instanceof ListenerLeakError &&
    error.message.includes('potential listener LEAK detected') &&
    stack.includes('at LanguageSelection._event') &&
    stack.includes('/editor/common/model/textModel.js:') &&
    stack.includes('at new TextModel') &&
    stack.includes('/base/common/observableInternal/observables/observableFromEvent.js:') &&
    stack.includes('at ModelService._createModelData')
  ) {
    warnings.push({ phase: 'creation', name: error.name, message: error.message, stack })
  } else {
    errors.push(stack)
  }
}
process.on('unhandledRejection', (error) => errors.push(String(error?.stack ?? error)))
process.on('uncaughtException', (error) => errors.push(String(error?.stack ?? error)))
window.addEventListener('error', (event) =>
  errors.push(String(event.error?.stack ?? event.message))
)
window.addEventListener('unhandledrejection', (event) =>
  errors.push(String(event.reason?.stack ?? event.reason))
)
const timeout = deadline(() => {
  process.stderr.write(
    `TypeScript admission fixture inconclusive: native task graph did not settle within 25s; finiteTasks=${scheduled.size}, workerRequests=${transport?.pending.size ?? 0}, tasks=${JSON.stringify([...scheduledDetails.values()])}, errors=${JSON.stringify(errors.slice(0, 3))}\n`
  )
  process.exit(2)
}, 25_000)
const widgets = []
const models = []
const managers = new Set()
let transport
let monaco
let result
try {
  monaco = await native('editor/editor.api.js')
  await native('basic-languages/typescript/typescript.contribution.js')
  await native('basic-languages/javascript/javascript.contribution.js')
  const ts = await native('language/typescript/monaco.contribution.js')
  transport = await import('./transport.mjs')
  transport.bindEditor(monaco.editor)
  const files = Number(process.argv[2])
  if (![20, 200].includes(files)) {
    throw new Error('Expected 20 or 200 file pairs')
  }
  const { configureMonacoTypeScriptDefaults } = await import(
    pathToFileURL(
      `${process.cwd()}/src/renderer/src/lib/editor/monaco/monaco-typescript-defaults.ts`
    )
  )
  configureMonacoTypeScriptDefaults(ts)
  const coldModels = monaco.editor.getModels().map((model) => model.uri.toString())
  if (coldModels.length) {
    throw new Error('Not a cold model service')
  }

  // Observe requests before automatic onLanguage setup without activating the mode here.
  const { WorkerManager } = await native('language/typescript/workerManager.js')
  const managerRequests = []
  const getWorker = WorkerManager.prototype.getLanguageServiceWorker
  WorkerManager.prototype.getLanguageServiceWorker = function (...resources) {
    managers.add(this)
    managerRequests.push({
      phase: transport.trace.phase,
      uris: resources.map(String),
      caller: new Error('Native language-service admission provenance').stack
    })
    return transport.observe(getWorker.apply(this, resources))
  }
  const providers = new Map()
  const ready = new Map(
    ['typescript', 'javascript'].map((language) => {
      let resolve
      const promise = new Promise((done) => {
        resolve = done
      })
      return [language, { promise, resolve }]
    })
  )
  const registrations = []
  const registerDefinition = monaco.languages.registerDefinitionProvider
  monaco.languages.registerDefinitionProvider = function (selector, provider) {
    const disposable = registerDefinition(selector, provider)
    registrations.push(disposable)
    const language = typeof selector === 'string' ? selector : selector.language
    providers.set(language, provider)
    ready.get(language)?.resolve()
    return disposable
  }
  const markerWrites = []
  const setMarkers = monaco.editor.setModelMarkers
  monaco.editor.setModelMarkers = function (model, owner, markers) {
    markerWrites.push({
      phase: transport.trace.phase,
      uri: model.uri.toString(),
      owner,
      markers: structuredClone(markers)
    })
    return setMarkers(model, owner, markers)
  }
  const { toEditorModelUri } = await import(
    pathToFileURL(
      `${process.cwd()}/src/renderer/src/components/editor/model-lifetime/identity/editor-model-uri.ts`
    )
  )
  const pairs = []
  creatingRetainedModels = true
  try {
    for (let index = 0; index < files; index++) {
      const language = index % 2 ? 'javascript' : 'typescript'
      const extension = language === 'typescript' ? 'ts' : 'js'
      const typed = language === 'typescript'
      const aUri = monaco.Uri.parse(
        toEditorModelUri(`/admission/file-${index}-declaration.${extension}`, 'admission-owner')
      )
      const bUri = monaco.Uri.parse(
        toEditorModelUri(`/admission/file-${index}-use.${extension}`, 'admission-owner')
      )
      const sharedName = `shared${index}`
      const a = monaco.editor.createModel(
        `function ${sharedName}(value${typed ? ': number' : ''}) { return String(value) }`,
        language,
        aUri
      )
      const b = monaco.editor.createModel(
        `${sharedName}(1)\nfunction local(value${typed ? ': number' : ''}) { return value + 1 }\nlocal(2)`,
        language,
        bUri
      )
      pairs.push({ a, b, language })
      models.push(a, b)
    }
  } finally {
    creatingRetainedModels = false
  }
  // Ordinary open editors keep all native providers; retained diff models need no widget.
  for (const { a, b } of pairs.slice(0, 2)) {
    for (const model of [a, b]) {
      const host = document.createElement('div')
      host.style.cssText = 'width:600px;height:300px'
      document.body.append(host)
      widgets.push(
        monaco.editor.create(host, {
          model,
          dimension: { width: 600, height: 300 },
          minimap: { enabled: false }
        })
      )
    }
  }
  await Promise.all([...ready.values()].map(({ promise }) => promise))
  async function settle() {
    do {
      await Promise.all([...scheduled, ...transport.pending])
      await new Promise((resolve) => setImmediate(resolve))
    } while (scheduled.size || transport.pending.size)
  }
  await settle()
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
  }
  async function definitions(pair, line) {
    const locations = await providers
      .get(pair.language)
      .provideDefinition(pair.b, { lineNumber: line, column: 2 }, token)
    return (locations ?? []).map(({ uri, range }) => ({
      uri: uri.toString(),
      range: {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn
      }
    }))
  }
  transport.trace.phase = 'definition'
  const useful = []
  for (const pair of pairs.slice(0, 2)) {
    useful.push({
      language: pair.language,
      a: pair.a.uri.toString(),
      b: pair.b.uri.toString(),
      shared: await definitions(pair, 1),
      local: await definitions(pair, 3)
    })
  }
  await settle()
  transport.trace.phase = 'edit'
  for (const { b, language } of pairs) {
    const typed = language === 'typescript'
    b.setValue(
      `${b.getLineContent(1)}\nfunction editedLocal(value${typed ? ': number' : ''}) { return value + 1 }\neditedLocal(2)`
    )
  }
  for (let index = 0; index < useful.length; index++) {
    useful[index].edited = await definitions(pairs[index], 3)
  }
  // Drain the native 500ms content-validation boundary as well as useful provider requests.
  await settle()
  const diagnosticRequests = managerRequests.filter(({ caller }) =>
    caller.includes('DiagnosticsAdapter._doValidate')
  )
  result = {
    files,
    modelCount: models.length,
    useful,
    diagnosticRequests,
    errors,
    warnings,
    markers: monaco.editor
      .getModelMarkers({ owner: 'typescript' })
      .concat(monaco.editor.getModelMarkers({ owner: 'javascript' })),
    retained: models.every((model) => monaco.editor.getModel(model.uri) === model),
    admissions: transport.trace.admissions,
    sync: transport.trace.sync,
    currentVersions: pairs
      .slice(0, 2)
      .map(({ b }) => ({ uri: b.uri.toString(), version: b.getVersionId() })),
    mirrors: transport.trace.transports.flatMap((worker) => worker.mirrors())
  }
  for (const disposable of registrations) {
    disposable.dispose()
  }
} finally {
  if (transport) {
    transport.trace.phase = 'retirement'
  }
  for (const widget of widgets) {
    widget.dispose()
  }
  for (const model of models) {
    model.dispose()
  }
  for (const manager of managers) {
    manager.dispose()
  }
  for (const worker of transport?.trace.transports ?? []) {
    worker.dispose()
  }
  if (result) {
    result.remainingMirrors = transport.trace.transports.flatMap((worker) => worker.mirrors())
    result.remainingModels = monaco.editor.getModels().map((model) => model.uri.toString())
  }
  await window.happyDOM.close()
  clearDeadline(timeout)
}
if (result) {
  process.stdout.write(`ADMISSION_RESULT ${JSON.stringify(result)}\n`, () =>
    process.exit(errors.length ? 1 : 0)
  )
}
