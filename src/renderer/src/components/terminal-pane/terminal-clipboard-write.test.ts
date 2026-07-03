import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeTerminalClipboardText } from './terminal-clipboard-write'

function installClipboardWriter(
  writeClipboardText: (text: string, options?: unknown) => Promise<void>
): void {
  vi.stubGlobal('window', {
    api: {
      ui: {
        writeClipboardText
      }
    }
  })
}

describe('writeTerminalClipboardText', () => {
  afterEach(() => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    vi.unstubAllGlobals()
  })

  it('requests desktop write verification for terminal copies', async () => {
    const writeClipboardText = vi
      .fn<(text: string, options?: unknown) => Promise<void>>()
      .mockResolvedValue(undefined)
    installClipboardWriter(writeClipboardText)

    await writeTerminalClipboardText('copilot answer')

    expect(writeClipboardText).toHaveBeenCalledWith('copilot answer', { verify: true })
  })

  it('keeps paired web clients on the browser clipboard write signal', async () => {
    const globals = globalThis as { __ORCA_WEB_CLIENT__?: boolean }
    globals.__ORCA_WEB_CLIENT__ = true
    const writeClipboardText = vi
      .fn<(text: string, options?: unknown) => Promise<void>>()
      .mockResolvedValue(undefined)
    installClipboardWriter(writeClipboardText)

    await writeTerminalClipboardText('copilot answer')

    expect(writeClipboardText).toHaveBeenCalledWith('copilot answer', undefined)
  })
})
