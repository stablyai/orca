import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { showTerminalShortcutCaptureNotification } from './terminal-shortcut-capture-notification'

const { toastMessage } = vi.hoisted(() => ({
  toastMessage: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    message: toastMessage
  }
}))

function createLocalStorage(): Storage {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}

describe('showTerminalShortcutCaptureNotification', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the shortcut capture warning visible until dismissed', () => {
    showTerminalShortcutCaptureNotification({
      actionId: 'tab.close',
      platform: 'darwin'
    })

    expect(toast.message).toHaveBeenCalledWith(
      'Orca handled a terminal shortcut',
      expect.objectContaining({
        duration: Infinity,
        dismissible: true,
        action: expect.objectContaining({ label: 'Open Shortcuts' })
      })
    )
  })
})
