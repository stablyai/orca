/** The `window.orca` an editor frame gets, as much of it as mockEditorHost's tests drive. */

export type MockEditorSession = {
  readonly value: unknown
  readonly readOnly: boolean
  change(next: unknown): void
  flush(): Promise<void>
  onReplace(handler: (value: unknown) => void): { dispose(): void }
  dispose(): void
}

// Method syntax: callers pass typed callbacks, which method parameters accept bivariantly.
export type MockEditorSessionOptions = {
  debounceMs?: number
  decode?(content: unknown): unknown
  encode?(value: unknown): unknown
  merge?(base: unknown, outside: unknown, mine: unknown): unknown
}

export type MockEditorFrameApi = {
  on(event: string, handler: (payload: unknown) => unknown): { dispose(): void }
  document: {
    get(): Promise<unknown>
    applyEdit(edit: unknown): Promise<unknown>
    session(options?: MockEditorSessionOptions): Promise<MockEditorSession>
  }
}

/** The frame shell's view of the page it runs in. */
export type MockEditorShellWindow = {
  __orcaPluginFrameTransport: {
    send(message: unknown): void
    subscribe(receive: (message: unknown) => void): void
  }
  addEventListener(): void
}
export type MockEditorShellDocument = {
  documentElement: { classList: { add(name: string): void; remove(...names: string[]): void } }
  getElementById(): null
}
export type MockEditorShellRunner = (
  window: MockEditorShellWindow,
  document: MockEditorShellDocument,
  navigator: { language: string }
) => void

export function isMockEditorFrameApi(value: unknown): value is MockEditorFrameApi {
  if (typeof value !== 'object' || value === null || !('on' in value) || !('document' in value)) {
    return false
  }
  const document = value.document
  return (
    typeof value.on === 'function' &&
    typeof document === 'object' &&
    document !== null &&
    'session' in document &&
    typeof document.session === 'function' &&
    'applyEdit' in document &&
    typeof document.applyEdit === 'function'
  )
}
