import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'
import type * as Osc52ClipboardToastModule from './osc52-clipboard-toast'

const { toastInfoMock, toastErrorMock, storeMock } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  toastErrorMock: vi.fn(),
  storeMock: {
    setSettingsSearchQuery: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfoMock,
    error: toastErrorMock
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeMock
  }
}))

async function importToastModule(): Promise<typeof Osc52ClipboardToastModule> {
  return import('./osc52-clipboard-toast')
}

describe('showOsc52ClipboardBlockedToast', () => {
  beforeEach(() => {
    vi.resetModules()
    toastInfoMock.mockReset()
    toastErrorMock.mockReset()
    storeMock.setSettingsSearchQuery.mockReset()
    storeMock.openSettingsTarget.mockReset()
    storeMock.openSettingsPage.mockReset()
  })

  it('deep-links to the OSC 52 terminal setting', async () => {
    const { showOsc52ClipboardBlockedToast } = await importToastModule()

    showOsc52ClipboardBlockedToast()

    expect(toastInfoMock.mock.calls[0]?.[1]?.description).toContain('Grok')
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

  it('keeps the session notice unspent when the toast throws', async () => {
    // Why: with the latch above toast.info, a throw burns the opted-out user's one
    // hint and every later blocked write fails silently. Only a throwing first call
    // separates the two orderings — the passing case satisfies both.
    const { showOsc52ClipboardBlockedToast } = await importToastModule()
    toastInfoMock.mockImplementationOnce(() => {
      throw new Error('toast unavailable')
    })

    expect(() => showOsc52ClipboardBlockedToast()).toThrow('toast unavailable')
    showOsc52ClipboardBlockedToast()

    expect(toastInfoMock).toHaveBeenCalledTimes(2)
  })

  it('mentions Grok and Zellij in every supported locale', () => {
    // Why assert the catalog, not the code fallback: en.json is bundled as the
    // `en` resource, so a catalog value silently wins over translate()'s fallback.
    const locales = [en, es, ja, ko, zh]

    for (const locale of locales) {
      const description =
        locale.auto.components.terminal.pane.osc52.clipboard.blocked.toast['7cf51f74fd']
      expect(description).toContain('Grok')
      expect(description).toContain('Zellij')
    }
  })
})

describe('showOsc52ClipboardFailedToast', () => {
  beforeEach(() => {
    vi.resetModules()
    toastErrorMock.mockReset()
  })

  it('reports that the host clipboard copy could not be confirmed', async () => {
    const { showOsc52ClipboardFailedToast } = await importToastModule()

    showOsc52ClipboardFailedToast()

    expect(toastErrorMock).toHaveBeenCalledWith('Terminal clipboard copy could not be confirmed', {
      description:
        'The terminal app requested a copy, but Orca could not confirm that it reached the system clipboard.',
      duration: 12_000
    })
  })

  it('only shows once per renderer session', async () => {
    const { showOsc52ClipboardFailedToast } = await importToastModule()

    showOsc52ClipboardFailedToast()
    showOsc52ClipboardFailedToast()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the session notice unspent when the toast throws', async () => {
    const { showOsc52ClipboardFailedToast } = await importToastModule()
    toastErrorMock.mockImplementationOnce(() => {
      throw new Error('toast unavailable')
    })

    expect(() => showOsc52ClipboardFailedToast()).toThrow('toast unavailable')
    showOsc52ClipboardFailedToast()

    expect(toastErrorMock).toHaveBeenCalledTimes(2)
  })
})
