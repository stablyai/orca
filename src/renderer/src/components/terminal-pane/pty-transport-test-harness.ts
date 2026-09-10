import { vi } from 'vitest'

export type PtyStreamPayload = { id: string; data: string }
export type PtyExitPayload = {
  id: string
  code: number
  preserveRendererBinding?: boolean
  /** Which lifetime of `id` died; absent when the execution host predates the field. */
  incarnationId?: string
}

/** Sinks let each spec own its `onData`/`onExit` bindings, so test bodies keep calling them directly. */
export type PtyListenerSinks = {
  data?: (callback: (payload: PtyStreamPayload) => void) => void
  replay?: (callback: (payload: PtyStreamPayload) => void) => void
  exit?: (callback: (payload: PtyExitPayload) => void) => void
  writeUnavailable?: (callback: (payload: { id: string }) => void) => void
}

export function flushPtySideEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Installs the `window.api.pty` IPC doubles the transport specs spawn against. */
export function installIpcPtyWindow(
  originalWindow: typeof window | undefined,
  sinks: PtyListenerSinks
): void {
  ;(globalThis as { window: typeof window }).window = {
    ...originalWindow,
    api: {
      ...originalWindow?.api,
      pty: {
        ...originalWindow?.api?.pty,
        spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
        write: vi.fn(),
        writeAccepted: vi.fn().mockResolvedValue(true),
        onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
          sinks.writeUnavailable?.(callback)
          return () => {}
        }),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn((callback: (payload: PtyStreamPayload) => void) => {
          sinks.data?.(callback)
          return () => {}
        }),
        onReplay: vi.fn((callback: (payload: PtyStreamPayload) => void) => {
          sinks.replay?.(callback)
          return () => {}
        }),
        onExit: vi.fn((callback: (payload: PtyExitPayload) => void) => {
          sinks.exit?.(callback)
          return () => {}
        })
      }
    }
  } as unknown as typeof window
}

export function restorePtySpecWindow(originalWindow: typeof window | undefined): void {
  if (originalWindow) {
    ;(globalThis as { window: typeof window }).window = originalWindow
  } else {
    delete (globalThis as { window?: typeof window }).window
  }
}
