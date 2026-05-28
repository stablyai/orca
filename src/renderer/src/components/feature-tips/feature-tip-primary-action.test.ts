import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { runFeatureTipPrimaryAction } from './feature-tip-primary-action'

function createDeps() {
  return {
    closeModal: vi.fn(),
    markFeatureTipsSeen: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    openUrl: vi.fn(),
    settings: null,
    updateSettings: vi.fn()
  }
}

describe('feature tip primary action', () => {
  it('opens the agent status release notes and marks the tip seen', () => {
    const tip = FEATURE_TIPS.find((item) => item.id === 'agent-status-sidebar')
    expect(tip).toBeDefined()
    if (!tip) {
      return
    }

    const deps = createDeps()
    runFeatureTipPrimaryAction(tip, deps)

    expect(deps.markFeatureTipsSeen).toHaveBeenCalledWith(['agent-status-sidebar'])
    expect(deps.closeModal).toHaveBeenCalledOnce()
    expect(deps.openUrl).toHaveBeenCalledWith('https://onorca.dev/changelog/1-3-41')
    expect(deps.updateSettings).not.toHaveBeenCalled()
    expect(deps.openSettingsPage).not.toHaveBeenCalled()
  })
})
