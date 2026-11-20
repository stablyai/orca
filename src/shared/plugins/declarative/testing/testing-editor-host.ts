import { runInThisContext } from 'node:vm'
import {
  isMockEditorFrameApi,
  type MockEditorFrameApi,
  type MockEditorShellDocument,
  type MockEditorShellRunner,
  type MockEditorShellWindow
} from './testing-editor-frame-api'
import {
  CUSTOM_EDITOR_CONFLICT,
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  CUSTOM_EDITOR_FLUSH_TIMEOUT_MS,
  CUSTOM_EDITOR_TOO_LARGE,
  readCustomEditorEdit,
  type CustomEditorContent,
  type CustomEditorDocument
} from '../../frames/plugin-custom-editor-bridge'
import { EDITOR_METHODS, FRAME_EVENTS } from '../../frames/plugin-frame-bridge'
import { buildPluginGuestShellHtml } from '../../frames/plugin-panel-shell'
import { structuredCloneMessageBytes } from '../../frames/plugin-panel-message-budget'
import {
  pluginError,
  PLUGIN_PROTOCOL_VERSION,
  type PluginError
} from '../../frames/plugin-protocol'

/**
 * A stand-in for Orca's custom editor host: runs the frame shell's real `window.orca` (document
 * API and session included) against an in-memory file, so editor sync logic tests in plain Node.
 */

export type MockEditorFile = { text: string } | { bytes: ArrayBuffer | Uint8Array }
export type MockEditorHostOptions = {
  readOnly?: boolean
  colorScheme?: 'light' | 'dark'
  locale?: string
  /** Bytes documents: the manifest suffix that matched. */
  fileType?: string
  /** A diff tab's original side; the document is then read-only and carries `diff`. */
  original?: string
}
export type MockEditorEdit = {
  baseVersion: number
  content: CustomEditorContent
  /** The refusal's code; absent when the edit was applied. */
  refused?: string
}
export type MockEditorHost = {
  /** The frame API, also installed as `globalThis.orca`. */
  readonly orca: MockEditorFrameApi
  /** The file as Orca holds it now: text, or undefined for a bytes file. */
  readonly text: string | undefined
  readonly bytes: Uint8Array | undefined
  /** Rises with each document sent to the editor. */
  readonly version: number
  /** Every `applyEdit`, in order. */
  readonly edits: readonly MockEditorEdit[]
  /** An outside change, such as an agent writing the file. */
  replace(next: string | ArrayBuffer | Uint8Array): void
  /** Refuses the next edit with `conflict`, after landing `outside` first when given. */
  conflictNext(outside?: string | ArrayBuffer | Uint8Array): void
  /** As a save does: asks the editor to post pending edits, and waits for its answer; rejects
   *  after an edit too large to apply, as Orca then refuses to save. */
  flush(): Promise<void>
  setTheme(colorScheme: 'light' | 'dark'): void
  dispose(): void
}

const isFrameMessage = (value: unknown): value is FrameMessage =>
  typeof value === 'object' && value !== null

type FrameMessage = {
  kind?: unknown
  event?: unknown
  method?: unknown
  id?: unknown
  params?: unknown
  error?: unknown
}

const SHELL_SCRIPT = /<script>\n'use strict'\n([\s\S]*?)<\/script>/.exec(
  buildPluginGuestShellHtml('', 'editor')
)?.[1]
let current: MockEditorHost | null = null

function toContent(next: string | ArrayBuffer | Uint8Array): CustomEditorContent {
  if (typeof next === 'string') {
    return { kind: 'text', text: next }
  }
  const view = next instanceof Uint8Array ? next : new Uint8Array(next)
  return { kind: 'bytes', bytes: view.slice().buffer }
}

function copy(content: CustomEditorContent): CustomEditorContent {
  return content.kind === 'text' ? content : { kind: 'bytes', bytes: content.bytes.slice(0) }
}

/** Installs `globalThis.orca` for a custom editor over `file`; one at a time, like `mount`. */
export function mockEditorHost(
  file: MockEditorFile,
  options: MockEditorHostOptions = {}
): MockEditorHost {
  current?.dispose()
  if (!SHELL_SCRIPT) {
    throw new Error('orca/testing: the frame shell script is missing')
  }
  let content = toContent('text' in file ? file.text : file.bytes)
  const readOnly = options.original !== undefined || (options.readOnly ?? false)
  const kind = content.kind
  let version = 0
  let colorScheme = options.colorScheme ?? 'dark'
  let disposed = false
  let conflict: { outside?: CustomEditorContent } | null = null
  let nextFlushId = 0
  const flushes = new Map<number, (error: unknown) => void>()
  const edits: MockEditorEdit[] = []
  let receive: (message: unknown) => void = () => {}

  const deliver = (message: Record<string, unknown>): void => {
    queueMicrotask(() => {
      if (!disposed) {
        receive({ orca: PLUGIN_PROTOCOL_VERSION, ...message })
      }
    })
  }
  const answer = (id: unknown, error: PluginError | null): void => {
    deliver(error ? { kind: 'res', id, error } : { kind: 'res', id, result: null })
  }
  const sendDocument = (): void => {
    version += 1
    const document: CustomEditorDocument = {
      version,
      readOnly,
      content: copy(content),
      ...(options.original === undefined
        ? {}
        : { diff: { original: { kind: 'text' as const, text: options.original } } }),
      ...(kind === 'bytes' && options.fileType ? { fileType: options.fileType } : {})
    }
    deliver({ kind: 'evt', event: FRAME_EVENTS.editorDocument, payload: document })
  }
  const theme = () => ({ colorScheme, tokens: '' })

  // As Orca's host: an oversized edit is refused before it is read, and blocks saving until a
  // later edit lands, because the buffer lacks the editor's newest change.
  let lostEdit = false
  const applyEdit = (message: FrameMessage): PluginError | null => {
    if (
      structuredCloneMessageBytes(message, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES) >
      CUSTOM_EDITOR_DOCUMENT_MAX_BYTES
    ) {
      lostEdit = true
      return CUSTOM_EDITOR_TOO_LARGE
    }
    const edit = readCustomEditorEdit(message.params)
    if (!edit) {
      return pluginError('invalid_params', 'malformed editor edit')
    }
    const refuse = (error: PluginError): PluginError => {
      edits.push({ ...edit, refused: error.code })
      return error
    }
    if (conflict) {
      const outside = conflict.outside
      conflict = null
      if (outside) {
        content = outside
        sendDocument()
      }
      return refuse(CUSTOM_EDITOR_CONFLICT)
    }
    if (readOnly) {
      return refuse(pluginError('not_permitted', 'This document is read-only.'))
    }
    if (edit.content.kind !== kind) {
      return refuse(pluginError('invalid_params', `content.kind: this editor edits ${kind}`))
    }
    if (edit.baseVersion !== version) {
      return refuse(CUSTOM_EDITOR_CONFLICT)
    }
    lostEdit = false
    content = copy(edit.content)
    edits.push({ ...edit, content: copy(edit.content) })
    return null
  }

  const fromFrame = (message: FrameMessage): void => {
    if (disposed) {
      return
    }
    if (message.kind === 'evt' && message.event === FRAME_EVENTS.ready) {
      deliver({ kind: 'evt', event: FRAME_EVENTS.hello, payload: hello() })
      sendDocument()
    } else if (message.kind === 'req' && message.method === EDITOR_METHODS.applyEdit) {
      answer(message.id, applyEdit(message))
    } else if (message.kind === 'req') {
      answer(
        message.id,
        pluginError('unknown_method', `mockEditorHost does not answer ${String(message.method)}`)
      )
    } else if (message.kind === 'res' && typeof message.id === 'number') {
      flushes.get(message.id)?.(message.error)
      flushes.delete(message.id)
    }
  }
  const hello = () => ({
    protocol: PLUGIN_PROTOCOL_VERSION,
    surface: 'editor',
    locale: options.locale ?? 'en-US',
    theme: theme()
  })

  const frameWindow: MockEditorShellWindow = {
    __orcaPluginFrameTransport: {
      send: (message) => fromFrame(isFrameMessage(message) ? message : {}),
      subscribe: (fn: (message: unknown) => void) => {
        receive = fn
      }
    },
    addEventListener: () => {}
  }
  const classes = new Set<string>()
  const frameDocument: MockEditorShellDocument = {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name))
      }
    },
    getElementById: () => null
  }
  const run: MockEditorShellRunner = runInThisContext(
    `(function (window, document, navigator) {\n'use strict'\n${SHELL_SCRIPT}\n})`
  )
  run(frameWindow, frameDocument, { language: options.locale ?? 'en-US' })
  const orca: unknown = Object.getOwnPropertyDescriptor(frameWindow, 'orca')?.value
  if (!isMockEditorFrameApi(orca)) {
    throw new Error('orca/testing: the frame shell did not define window.orca')
  }
  Object.defineProperty(globalThis, 'orca', { value: orca, configurable: true, writable: true })

  const host: MockEditorHost = {
    orca,
    get text() {
      return content.kind === 'text' ? content.text : undefined
    },
    get bytes() {
      return content.kind === 'bytes' ? new Uint8Array(content.bytes.slice(0)) : undefined
    },
    get version() {
      return version
    },
    edits,
    replace(next) {
      content = toContent(next)
      sendDocument()
    },
    conflictNext(outside) {
      conflict = outside === undefined ? {} : { outside: toContent(outside) }
    },
    flush() {
      const id = nextFlushId++
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          flushes.delete(id)
          reject(
            new Error(
              `the editor did not answer editor.flush within ${CUSTOM_EDITOR_FLUSH_TIMEOUT_MS} ms`
            )
          )
        }, CUSTOM_EDITOR_FLUSH_TIMEOUT_MS)
        flushes.set(id, (error) => {
          clearTimeout(timer)
          if (error) {
            reject(new Error(`editor.flush failed: ${JSON.stringify(error)}`))
          } else if (lostEdit) {
            reject(new Error("Orca would not save: the editor's newest edit was too large"))
          } else {
            resolve()
          }
        })
        deliver({ kind: 'req', id, method: EDITOR_METHODS.flush })
      })
    },
    setTheme(next) {
      colorScheme = next
      deliver({ kind: 'evt', event: FRAME_EVENTS.theme, payload: theme() })
    },
    dispose() {
      disposed = true
      flushes.clear()
      if (Object.getOwnPropertyDescriptor(globalThis, 'orca')?.value === orca) {
        Reflect.deleteProperty(globalThis, 'orca')
      }
      if (current === host) {
        current = null
      }
    }
  }
  current = host
  return host
}
