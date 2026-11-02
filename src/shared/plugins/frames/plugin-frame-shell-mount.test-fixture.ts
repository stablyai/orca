import { afterEach, vi, type Mock } from 'vitest'
import { buildPluginPanelShellHtml, type PluginFrameSurface } from './plugin-panel-shell'

/** The injected `window.orca` is the public frame API; the envelope under it stays internal. */
export type FrameOrca = {
  api: { major: number; minor: number }
  host: {
    call: (method: string, params?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    has: (method: string) => boolean
  }
  on: (event: string, handler: (payload: unknown) => unknown) => { dispose: () => void }
  locale: string
  plugin: object
  storage: object
  shell?: { openExternal: (url: string) => Promise<unknown> }
  files?: {
    saveAs: (options: {
      suggestedName?: string
      mimeType?: string
      data: unknown
    }) => Promise<unknown>
  }
  document?: {
    get: () => Promise<unknown>
    onDidChange: (handler: (document: unknown) => void) => { dispose: () => void }
    applyEdit: (edit: unknown) => Promise<unknown>
  }
}

const realParent = window.parent

// Registered by importing: each test gets the real `window.parent` back.
afterEach(() => {
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true })
})

export type MountedShell = {
  orca: FrameOrca
  parent: { postMessage: Mock<(message: Record<string, unknown>) => void> }
  fromHost: (data: unknown, source?: unknown) => boolean
  posted: () => Record<string, unknown>[]
}

export function mountShell(surface: PluginFrameSurface = 'panel'): MountedShell {
  const parent = { postMessage: vi.fn<(message: Record<string, unknown>) => void>() }
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  const script = buildPluginPanelShellHtml('<main></main>', surface).match(
    /<script>\n([\s\S]*?)<\/script>/
  )?.[1]
  // Configurable only so happy-dom can tear down; the frame's copy stays locked.
  window.eval(script!.replaceAll('configurable: false', 'configurable: true'))
  const orca: FrameOrca = Object.getOwnPropertyDescriptor(window, 'orca')?.value
  const fromHost = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shim only compares source identity.
      new MessageEvent('message', { data, source: source as Window })
    )
  const posted = () => parent.postMessage.mock.calls.map(([message]) => message)
  return { orca, parent, fromHost, posted }
}

export const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))
