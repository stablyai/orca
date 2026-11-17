import { describe, expect, it } from 'vitest'
import {
  AGENT_CREDENTIAL_NAMES,
  cloudSecretKind,
  cloudSecretStoredOnVm,
  cloudSecretSwapped
} from './cloud-secret-rules'

describe('agent keys the workspace VM holds in full', () => {
  it('flags every agent credential that is not swapped, and only those', () => {
    for (const name of AGENT_CREDENTIAL_NAMES) {
      expect(cloudSecretStoredOnVm(name), name).toBe(!cloudSecretSwapped(name))
    }
    for (const name of [
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK'
    ]) {
      expect(cloudSecretStoredOnVm(name), name).toBe(true)
    }
    // Ordinary variables are the user's own business, not agent credentials.
    for (const name of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'AWS_REGION']) {
      expect(cloudSecretStoredOnVm(name), name).toBe(false)
    }
  })

  it('marks the AWS keys, which the egress proxy cannot swap', () => {
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
