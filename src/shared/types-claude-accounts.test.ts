import { describe, it, expectTypeOf } from 'vitest'
import type { ClaudeManagedAccount, ClaudeAuthCredentials } from './types'

describe('ClaudeAuthCredentials', () => {
  it('subscription-oauth has no extra fields', () => {
    const c: ClaudeAuthCredentials = { authMethod: 'subscription-oauth' }
    expectTypeOf(c).toMatchTypeOf<{ authMethod: 'subscription-oauth' }>()
  })

  it('anthropic-api-key has no extra fields', () => {
    const c: ClaudeAuthCredentials = { authMethod: 'anthropic-api-key' }
    expectTypeOf(c).toMatchTypeOf<{ authMethod: 'anthropic-api-key' }>()
  })

  it('anthropic-compat requires baseUrl + preset', () => {
    const c: ClaudeAuthCredentials = {
      authMethod: 'anthropic-compat',
      baseUrl: 'https://api.z.ai/api/anthropic',
      preset: 'zai',
    }
    expectTypeOf(c).toMatchTypeOf<{
      authMethod: 'anthropic-compat'
      baseUrl: string
      preset: 'zai' | 'kimi' | 'minimax' | 'custom'
    }>()
  })

  it('ClaudeManagedAccount carries credentials union + modelMapping + fallbackAccountIds', () => {
    const account: ClaudeManagedAccount = {
      id: 'a',
      email: 'a@b.com',
      managedAuthPath: '/tmp',
      authMethod: 'subscription-oauth',
      credentials: { authMethod: 'subscription-oauth' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0,
    }
    expectTypeOf(account.credentials).toMatchTypeOf<ClaudeAuthCredentials>()
  })
})
