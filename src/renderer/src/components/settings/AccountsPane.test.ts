import { describe, expect, it } from 'vitest'
import {
  buildClaudeAddAccountInput,
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
