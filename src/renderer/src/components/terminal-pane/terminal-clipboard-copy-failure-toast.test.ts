import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalClipboardCopyFailureToastModule from './terminal-clipboard-copy-failure-toast'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

async function importToastModule(): Promise<typeof TerminalClipboardCopyFailureToastModule> {
  return import('./terminal-clipboard-copy-failure-toast')
}

describe('showTerminalClipboardCopyFailedToast', () => {
  beforeEach(() => {
    vi.resetModules()
    toastErrorMock.mockReset()
  })

  it('reports that terminal selection copy did not update the system clipboard', async () => {
    const { showTerminalClipboardCopyFailedToast } = await importToastModule()

    showTerminalClipboardCopyFailedToast()

    expect(toastErrorMock).toHaveBeenCalledWith('Terminal copy failed', {
      description: 'The system clipboard did not update. Your selection is still highlighted.',
      duration: 12_000
    })
  })

  it('only shows once per renderer session', async () => {
    const { showTerminalClipboardCopyFailedToast } = await importToastModule()

    showTerminalClipboardCopyFailedToast()
    showTerminalClipboardCopyFailedToast()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })
})
