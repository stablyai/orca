import { describe, expect, it } from 'vitest'
import {
  buildClaudeAddAccountInput,
  pickClaudeValidationBadgeState,
  resolveClaudeAddAccountAction
} from './AccountsPane'

describe('resolveClaudeAddAccountAction', () => {
  it('runs the OAuth path when the multi-provider flag is undefined', () => {
    expect(resolveClaudeAddAccountAction(undefined)).toBe('run-oauth')
  })

  it('runs the OAuth path when the multi-provider flag is false', () => {
    expect(resolveClaudeAddAccountAction(false)).toBe('run-oauth')
  })

  it('opens the modal when the multi-provider flag is true', () => {
    expect(resolveClaudeAddAccountAction(true)).toBe('open-modal')
  })
})

describe('buildClaudeAddAccountInput', () => {
  it('passes an anthropic-api-key submit through to the IPC input shape', () => {
    const input = buildClaudeAddAccountInput({
      authMethod: 'anthropic-api-key',
      label: 'work key',
      secretFromUser: 'sk-ant-xxx'
    })
    expect(input).toEqual({
      authMethod: 'anthropic-api-key',
      label: 'work key',
      secretFromUser: 'sk-ant-xxx'
    })
  })

  it('passes an anthropic-compat submit through to the IPC input shape', () => {
    const input = buildClaudeAddAccountInput({
      authMethod: 'anthropic-compat',
      label: 'zai',
      secretFromUser: 'token-123',
      providerConfig: { preset: 'zai' }
    })
    expect(input).toEqual({
      authMethod: 'anthropic-compat',
      label: 'zai',
      secretFromUser: 'token-123',
      providerConfig: { preset: 'zai' }
    })
  })
})

describe('pickClaudeValidationBadgeState', () => {
  it('returns unvalidated when no entry is present', () => {
    expect(pickClaudeValidationBadgeState(undefined)).toEqual({ kind: 'unvalidated' })
  })

  it('returns pending for the literal string sentinel', () => {
    expect(pickClaudeValidationBadgeState('pending')).toEqual({ kind: 'pending' })
  })

  it('returns valid when the probe succeeded', () => {
    expect(pickClaudeValidationBadgeState({ ok: true })).toEqual({ kind: 'valid' })
  })

  it('returns invalid + reason/rescueHint when the probe failed', () => {
    expect(
      pickClaudeValidationBadgeState({
        ok: false,
        reason: 'API key invalid or revoked.',
        rescueHint: 'Generate a new key.'
      })
    ).toEqual({
      kind: 'invalid',
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key.'
    })
  })
})
