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
    // Why: pre-hydration the store holds `false` for everyone, so firing on that
    // value would nag every profile — including the ones never opted out.
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
    // Why not consume on enqueue: quitting inside the toast's 15s would burn the profile's
    // only notice on a launch where the posture change was never actually communicated.
    await mountProbe(true)

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()
  })

  it.each(['onAutoClose', 'onDismiss'] as const)('consumes the notice on %s', async (callback) => {
    await mountProbe(true)

    // Why assert the option exists before invoking: optional chaining makes a missing
    // callback a silent no-op, so a revert to clear-at-enqueue would satisfy the count
    // below without ever wiring this close path.
    const close = toastInfoMock.mock.calls[0]?.[1]?.[callback]
    expect(close).toBeTypeOf('function')
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()

    close()

    expect(storeState.clearOsc52ClipboardDefaultOnNotice).toHaveBeenCalledTimes(1)
  })

  it('dedupes the StrictMode double-invoke with a stable toast id', async () => {
    // Why pin the id: the effect re-runs against the same closure, so the early return
    // cannot catch the second pass — sonner collapses it only because the id matches.
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

    // Why assert unspent first: without it, a revert to clear-at-enqueue satisfies the
    // count below and the action's own clear becomes deletable with nothing going red.
    expect(storeState.clearOsc52ClipboardDefaultOnNotice).not.toHaveBeenCalled()

    options.action.onClick()

    // Why assert the clear here: sonner's action path deletes the toast without firing
    // onDismiss, so acting on the notice would otherwise leave it to re-toast next launch.
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
