import { afterEach, expect, it, vi } from 'vitest'
import { setTerminalPtyWriteDelay } from './terminal-pty-write-spy'

declare global {
  var __terminalPtyWriteDelayMs: number | undefined
}

afterEach(() => vi.unstubAllGlobals())

it('sets and clears paste backpressure using the main-process evaluate argument', async () => {
  vi.stubGlobal('__terminalPtyWriteDelayMs', 0)
  const evaluate = vi.fn()
  evaluate.mockImplementation(
    (callback: (electron: unknown, argument: number) => void, delay: number) =>
      callback(undefined, delay)
  )
  const app = { evaluate }

  await setTerminalPtyWriteDelay(app, 35)
  expect(globalThis.__terminalPtyWriteDelayMs).toBe(35)
  await setTerminalPtyWriteDelay(app, 0)
  expect(globalThis.__terminalPtyWriteDelayMs).toBe(0)
})
