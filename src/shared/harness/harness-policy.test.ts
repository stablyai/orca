import { describe, expect, it } from 'vitest'
import {
  checkToolCommandAllowed,
  createHarnessPolicyFromPreset,
  evaluateCompletionGate,
  validateCommitMessage
} from './harness-policy'

describe('harness-policy', () => {
  it('enforces google-cl subject and body rules when enabled', () => {
    const policy = createHarnessPolicyFromPreset('google-cl')
    expect(validateCommitMessage('Add feature.', policy).allowed).toBe(false)
    expect(validateCommitMessage('Add feature', policy).allowed).toBe(false)
    expect(
      validateCommitMessage('Add composable harness policy\n\nExplain why this is needed.', policy)
        .allowed
    ).toBe(true)
  })

  it('allows any message when commitFormat is off', () => {
    const policy = createHarnessPolicyFromPreset('off')
    expect(validateCommitMessage('wip', policy).allowed).toBe(true)
  })

  it('blocks --no-verify and dirty completion under google-cl', () => {
    const policy = createHarnessPolicyFromPreset('google-cl')
    expect(checkToolCommandAllowed('git commit -m "x" --no-verify', policy).allowed).toBe(false)
    expect(evaluateCompletionGate(true, policy).allowed).toBe(false)
    expect(evaluateCompletionGate(false, policy).allowed).toBe(true)
  })
})
