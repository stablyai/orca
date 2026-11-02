// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OSC52_CLIPBOARD_SETTING_ID } from './osc52-clipboard-setting-anchor'
import {
  shouldShowOsc52ClipboardDefaultOnNotice,
  useOsc52ClipboardDefaultOnNotice
} from './osc52-clipboard-default-on-notice'

const { toastInfoMock, storeState } = vi.hoisted(() => ({
  toastInfoMock: vi.fn(),
  storeState: {
    osc52ClipboardDefaultOnNoticePending: true,
    clearOsc52ClipboardDefaultOnNotice: vi.fn(),
    setSettingsSearchQuery: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

vi.mock('@/store', () => {
  const useAppStore = <T>(selector: (state: typeof storeState) => T): T => selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

const mountedRoots: Root[] = []

function HookProbe({ persistedUIReady }: { persistedUIReady: boolean }): null {
  useOsc52ClipboardDefaultOnNotice(persistedUIReady)
  return null
}

async function mountProbe(persistedUIReady: boolean): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { persistedUIReady }))
  })
}

describe('shouldShowOsc52ClipboardDefaultOnNotice', () => {
  it('shows once the migrating profile has hydrated', () => {
    expect(
      shouldShowOsc52ClipboardDefaultOnNotice({ persistedUIReady: true, noticePending: true })
    ).toBe(true)
  })

  it('stays quiet before hydration, when the flag still reads its default', () => {
    // Before hydration false is the default for every profile, including those that never opted out.
    expect(
      shouldShowOsc52ClipboardDefaultOnNotice({ persistedUIReady: false, noticePending: true })
    ).toBe(false)
    expect(
      shouldShowOsc52ClipboardDefaultOnNotice({ persistedUIReady: false, noticePending: false })
    ).toBe(false)
  })

  it('stays quiet for a profile the migration did not override', () => {
    expect(
      shouldShowOsc52ClipboardDefaultOnNotice({ persistedUIReady: true, noticePending: false })
    ).toBe(false)
  })
})

describe('useOsc52ClipboardDefaultOnNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    storeState.osc52ClipboardDefaultOnNoticePending = true
    storeState.clearOsc52ClipboardDefaultOnNotice.mockReset()
    storeState.setSettingsSearchQuery.mockReset()
    storeState.openSettingsTarget.mockReset()
    storeState.openSettingsPage.mockReset()
  })

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount())
    }
    document.body.innerHTML = ''
  })

  it('toasts the armed profile without spending the notice up front', async () => {
    // Enqueue must not spend the profile’s only notice if the app quits before it is seen.
    await mountProbe(true)

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()
  })

  it.each(['onAutoClose', 'onDismiss'] as const)('consumes the notice on %s', async (callback) => {
    await mountProbe(true)

    // Require the callback before invoking it so missing close wiring cannot pass as a no-op.
    const close = toastInfoMock.mock.calls[0]?.[1]?.[callback]
    expect(close).toBeTypeOf('function')
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()

    close()

    expect(storeState.clearOsc52ClipboardDefaultOnNotice).toHaveBeenCalledTimes(1)
  })

  it('assigns a stable toast id for notice deduplication', async () => {
    // StrictMode repeats the same closure; sonner needs a stable ID to collapse the second toast.
    await mountProbe(true)

    expect(toastInfoMock.mock.calls[0]?.[1]?.id).toBe('osc52-clipboard-default-on-notice')
  })

  it('keeps the notice armed when the toast throws, so it is not burned unshown', async () => {
    toastInfoMock.mockImplementationOnce(() => {
      throw new Error('toast unavailable')
    })

    await expect(mountProbe(true)).rejects.toThrow('toast unavailable')
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()
  })

  it('stays silent for a disarmed profile and before hydration', async () => {
    storeState.osc52ClipboardDefaultOnNoticePending = false
    await mountProbe(true)
    expect(toastInfoMock).not.toHaveBeenCalled()

    storeState.osc52ClipboardDefaultOnNoticePending = true
    await mountProbe(false)
    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()
  })

  it('deep-links to the OSC 52 terminal setting', async () => {
    await mountProbe(true)

    const options = toastInfoMock.mock.calls[0]?.[1]
    expect(options.description).toContain('Zellij')
    expect(options.action.label).toBe('Open Setting')

    // Prove enqueue leaves the notice unspent so the action’s clear remains necessary.
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()

    options.action.onClick()

    // Sonner actions omit onDismiss, so the action must consume the notice itself.
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).toHaveBeenCalledTimes(1)
    expect(storeState.setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(storeState.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'terminal',
      repoId: null,
      sectionId: OSC52_CLIPBOARD_SETTING_ID
    })
    expect(storeState.openSettingsPage).toHaveBeenCalledTimes(1)
  })
})
