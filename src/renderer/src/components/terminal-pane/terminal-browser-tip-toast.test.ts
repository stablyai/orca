import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import {
  resetTerminalBrowserTipToastForTests,
  showTerminalBrowserTipToast
} from './terminal-browser-tip-toast'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn()
  }
}))

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    openLinksInApp: false,
    openLinksInAppPreferencePrompted: false,
    activeRuntimeEnvironmentId: null,
    ...overrides
  } as GlobalSettings
}

function makeDeps(
  overrides: {
    settings?: GlobalSettings | null
    updateSettings?: (updates: Partial<GlobalSettings>) => Promise<unknown>
  } = {}
) {
  return {
    context: { worktreeId: 'wt-1', connectionId: null },
    settings: 'settings' in overrides ? overrides.settings : makeSettings(),
    updateSettings: overrides.updateSettings ?? vi.fn().mockResolvedValue(undefined),
    setSettingsSearchQuery: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTerminalBrowserTipToastForTests()
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('showTerminalBrowserTipToast', () => {
  it('shows once and persists the first-use flag', () => {
    const deps = makeDeps()

    expect(showTerminalBrowserTipToast(deps)).toBe(true)
    expect(toast.info).toHaveBeenCalledWith(
      'Terminal links can open in Orca Browser',
      expect.objectContaining({
        description: 'Use ⇧⌘-click once, or turn on Link Routing in Settings -> Browser.'
      })
    )
    expect(deps.updateSettings).toHaveBeenCalledWith({ openLinksInAppPreferencePrompted: true })
  })

  it('does not show when settings are not hydrated', () => {
    const deps = makeDeps({ settings: null })

    expect(showTerminalBrowserTipToast(deps)).toBe(false)
    expect(toast.info).not.toHaveBeenCalled()
    expect(deps.updateSettings).not.toHaveBeenCalled()
  })

  it('suppresses repeats after a persistence failure', () => {
    const deps = makeDeps({ updateSettings: vi.fn().mockRejectedValue(new Error('nope')) })

    expect(showTerminalBrowserTipToast(deps)).toBe(true)
    expect(showTerminalBrowserTipToast(deps)).toBe(false)

    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(deps.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('opens Browser settings from the toast action', () => {
    const deps = makeDeps()

    showTerminalBrowserTipToast(deps)
    const options = vi.mocked(toast.info).mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined
    options?.action?.onClick?.()

    expect(deps.setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(deps.openSettingsTarget).toHaveBeenCalledWith({ pane: 'browser', repoId: null })
    expect(deps.openSettingsPage).toHaveBeenCalled()
  })
})
