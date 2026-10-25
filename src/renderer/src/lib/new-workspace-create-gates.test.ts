import { describe, expect, it } from 'vitest'
import {
  getQuickComposerCreateDisabled,
  type ComposerCreateGateInput
} from './new-workspace-create-gates'

const readyInput: ComposerCreateGateInput = {
  repoId: 'repo-1',
  workspaceSeedName: 'feature',
  creating: false,
  requiresExplicitSetupChoice: false,
  hasSetupDecision: false,
  selectedRepoRequiresConnection: false,
  sparseError: null
}

describe('new workspace create gates', () => {
  it('keeps quick create clickable when no repo is selected so submit can validate inline', () => {
    expect(getQuickComposerCreateDisabled({ ...readyInput, repoId: '' })).toBe(false)
  })

  it('still blocks quick create for other missing form state and explicit setup choices', () => {
    expect(getQuickComposerCreateDisabled({ ...readyInput, workspaceSeedName: '' })).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...readyInput, creating: true })).toBe(true)
    expect(
      getQuickComposerCreateDisabled({ ...readyInput, selectedRepoRequiresConnection: true })
    ).toBe(true)
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

  it('blocks quick create synchronously for unresolved source intent', () => {
    const blocked = { ...readyInput, sourceIntentBlocksCreate: true }

    expect(getQuickComposerCreateDisabled(blocked)).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...blocked, sourceIntentBlocksCreate: false })).toBe(
      false
    )
  })
})
