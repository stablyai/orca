import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { prepareSkippedOnboardingPreferences } from './use-onboarding-flow'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

describe('prepareSkippedOnboardingPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('surfaces theme restore persistence failures without throwing', async () => {
    const setTheme = vi.fn()
    const applyTheme = vi.fn()
    const updateSettings = vi.fn().mockRejectedValue(new Error('settings IPC failed'))
    const setError = vi.fn()

    await expect(
      prepareSkippedOnboardingPreferences({
        currentStepId: 'theme',
        themeBeforePreview: 'dark',
        settingsTheme: 'light',
        selectedAgent: null,
        setTheme,
        applyTheme,
        updateSettings,
        setError
      })
    ).resolves.toBe(false)

    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(applyTheme).toHaveBeenCalledWith('dark')
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })
    expect(setError).toHaveBeenCalledWith('settings IPC failed')
    expect(toast.error).toHaveBeenCalledWith('Could not save progress', {
      description: 'settings IPC failed'
    })
  })

  it('keeps the selected agent preference before jumping to repo setup', async () => {
    const setTheme = vi.fn()
    const applyTheme = vi.fn()
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const setError = vi.fn()

    await expect(
      prepareSkippedOnboardingPreferences({
        currentStepId: 'agent',
        themeBeforePreview: null,
        settingsTheme: 'light',
        selectedAgent: 'codex',
        setTheme,
        applyTheme,
        updateSettings,
        setError
      })
    ).resolves.toBe(true)

    expect(setTheme).not.toHaveBeenCalled()
    expect(applyTheme).not.toHaveBeenCalled()
    expect(updateSettings).toHaveBeenCalledWith({ defaultTuiAgent: 'codex' })
    expect(setError).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
