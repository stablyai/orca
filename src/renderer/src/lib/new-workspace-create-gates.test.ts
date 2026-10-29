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
  it('blocks quick create synchronously for unresolved source intent', () => {
    const blocked = { ...readyInput, sourceIntentBlocksCreate: true }

    expect(getQuickComposerCreateDisabled(blocked)).toBe(true)
    expect(getQuickComposerCreateDisabled({ ...blocked, sourceIntentBlocksCreate: false })).toBe(
      false
    )
  })
})
