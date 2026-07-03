// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useMobileEmulatorTabIntroActions } from './use-mobile-emulator-tab-intro-actions'

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestActions: ReturnType<typeof useMobileEmulatorTabIntroActions> | null = null

function Probe(): null {
  latestActions = useMobileEmulatorTabIntroActions()
  return null
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

async function flushAsyncAction(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function configureStoreForHideAction(overrides: {
  updateSettings: AppState['updateSettings']
  closeUnifiedTab?: AppState['closeUnifiedTab']
  dismissMobileEmulatorTabIntro?: AppState['dismissMobileEmulatorTabIntro']
}): {
  closeUnifiedTab: NonNullable<typeof overrides.closeUnifiedTab>
  dismissMobileEmulatorTabIntro: NonNullable<typeof overrides.dismissMobileEmulatorTabIntro>
  openSettingsPage: AppState['openSettingsPage']
  openSettingsTarget: AppState['openSettingsTarget']
} {
  const closeUnifiedTab =
    overrides.closeUnifiedTab ??
    vi.fn(() => ({
      closedTabId: 'simulator-tab',
      wasLastTab: false,
      worktreeId: 'worktree-1'
    }))
  const dismissMobileEmulatorTabIntro = overrides.dismissMobileEmulatorTabIntro ?? vi.fn()
  const openSettingsPage = vi.fn()
  const openSettingsTarget = vi.fn()

  useAppStore.setState({
    closeUnifiedTab,
    dismissMobileEmulatorTabIntro,
    openSettingsPage,
    openSettingsTarget,
    settings: { mobileEmulatorEnabled: true } as AppState['settings'],
    unifiedTabsByWorktree: {
      'worktree-1': [
        { id: 'simulator-tab', contentType: 'simulator' },
        { id: 'terminal-tab', contentType: 'terminal' }
      ]
    } as unknown as AppState['unifiedTabsByWorktree'],
    updateSettings: overrides.updateSettings
  })

  return {
    closeUnifiedTab,
    dismissMobileEmulatorTabIntro,
    openSettingsPage,
    openSettingsTarget
  }
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  latestActions = null
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.clearAllMocks()
})

describe('useMobileEmulatorTabIntroActions', () => {
  it('hides the feature, dismisses the intro, and closes simulator tabs after settings apply', async () => {
    const updateSettings = vi.fn<AppState['updateSettings']>(async () => {
      useAppStore.setState({
        settings: { mobileEmulatorEnabled: false } as AppState['settings']
      })
    })
    const { closeUnifiedTab, dismissMobileEmulatorTabIntro } = configureStoreForHideAction({
      updateSettings
    })

    await renderProbe()

    latestActions?.hideIntro()
    await flushAsyncAction()

    expect(updateSettings).toHaveBeenCalledWith({ mobileEmulatorEnabled: false })
    expect(dismissMobileEmulatorTabIntro).toHaveBeenCalledTimes(1)
    expect(closeUnifiedTab).toHaveBeenCalledTimes(1)
    expect(closeUnifiedTab).toHaveBeenCalledWith('simulator-tab')
    expect(toast.info).toHaveBeenCalledWith(
      'Mobile Emulator hidden',
      expect.objectContaining({ id: 'mobile-emulator-hidden', duration: 30_000 })
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does not dismiss or close tabs when the setting write does not stick', async () => {
    const updateSettings = vi.fn<AppState['updateSettings']>(async () => {})
    const { closeUnifiedTab, dismissMobileEmulatorTabIntro } = configureStoreForHideAction({
      updateSettings
    })

    await renderProbe()

    latestActions?.hideIntro()
    await flushAsyncAction()

    expect(dismissMobileEmulatorTabIntro).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not hide Mobile Emulator.')
  })
})
