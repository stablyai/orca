import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'
import type * as Osc52ClipboardBlockedToastModule from './osc52-clipboard-blocked-toast'

const { toastInfoMock, storeMock } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  storeMock: {
    setSettingsSearchQuery: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfoMock
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeMock
  }
}))

async function importToastModule(): Promise<typeof Osc52ClipboardBlockedToastModule> {
  return import('./osc52-clipboard-blocked-toast')
}

describe('showOsc52ClipboardBlockedToast', () => {
  beforeEach(() => {
    vi.resetModules()
    toastInfoMock.mockReset()
    storeMock.setSettingsSearchQuery.mockReset()
    storeMock.openSettingsTarget.mockReset()
    storeMock.openSettingsPage.mockReset()
  })

  it('deep-links to the OSC 52 terminal setting', async () => {
    const { showOsc52ClipboardBlockedToast } = await importToastModule()

    showOsc52ClipboardBlockedToast()

    const options = toastInfoMock.mock.calls[0]?.[1]
    expect(options).toMatchObject({
      action: {
        label: 'Open Setting'
      }
    })

    options.action.onClick()

    expect(storeMock.setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(storeMock.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'terminal',
      repoId: null,
      sectionId: OSC52_CLIPBOARD_SETTING_ID
    })
    expect(storeMock.openSettingsPage).toHaveBeenCalled()
  })

  it('only shows once per renderer session', async () => {
    const { showOsc52ClipboardBlockedToast } = await importToastModule()

    showOsc52ClipboardBlockedToast()
    showOsc52ClipboardBlockedToast()

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })
})
