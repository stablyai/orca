import { describe, expect, it } from 'vitest'
import {
  getFullComposerCreateDisabled,
  getQuickComposerCreateDisabled,
  type ComposerCreateGateInput
} from './new-workspace-create-gates'

const readyInput: ComposerCreateGateInput = {
  repoId: 'repo-1',
  workspaceSeedName: 'feature',
  creating: false,
  shouldWaitForSetupCheck: false,
  shouldWaitForIssueAutomationCheck: false,
  requiresExplicitSetupChoice: false,
  hasSetupDecision: false,
  sparseError: null
}

describe('new workspace create gates', () => {
  it('keeps the full composer disabled while setup and issue automation probes are pending', () => {
    expect(
      getFullComposerCreateDisabled({
        ...readyInput,
        shouldWaitForSetupCheck: true
      })
    ).toBe(true)

    expect(
      getFullComposerCreateDisabled({
        ...readyInput,
        shouldWaitForIssueAutomationCheck: true
      })
    ).toBe(true)
  })

  it('lets quick create submit while background setup and issue probes are pending', () => {
    expect(
      getQuickComposerCreateDisabled({
        ...readyInput,
        shouldWaitForSetupCheck: true,
        shouldWaitForIssueAutomationCheck: true
      })
    ).toBe(false)
  })

  it('still blocks quick create for missing form state and explicit setup choices', () => {
    expect(getQuickComposerCreateDisabled({ ...readyInput, repoId: '' })).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...readyInput, workspaceSeedName: '' })).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...readyInput, creating: true })).toBe(true)
    expect(
      getQuickComposerCreateDisabled({
        ...readyInput,
        requiresExplicitSetupChoice: true,
        hasSetupDecision: false
      })
    ).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...readyInput, sparseError: 'Bad sparse path' })).toBe(
      true
    )
  })
})
