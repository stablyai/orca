import { describe, expect, it } from 'vitest'
import { cloudSecretKind, cloudSecretStoredOnVm } from './cloud-secret-rules'

describe('agent keys the workspace VM holds in full', () => {
  it('marks only the AWS keys, which the egress proxy cannot swap', () => {
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK'
    ]) {
      expect(cloudSecretStoredOnVm(name)).toBe(true)
    }
    for (const name of [
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'CURSOR_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'DATABASE_URL',
      'AWS_REGION'
    ]) {
      expect(cloudSecretStoredOnVm(name)).toBe(false)
    }
  })

  it('treats the new agent credentials as agent keys (shared beats personal), except a personal GitHub token', () => {
    for (const name of [
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'COPILOT_PROVIDER_API_KEY',
      'COPILOT_PROVIDER_BASE_URL'
    ]) {
      expect(cloudSecretKind(name)).toBe('agent_key')
    }
    // One person's GitHub token: a personal value wins over a team one.
    expect(cloudSecretKind('COPILOT_GITHUB_TOKEN')).toBe('env')
  })
})
