import { describe, expect, it } from 'vitest'
import { summarizeRecipeForwardedEnv } from './ephemeral-vm-recipe-forwarded-env'

describe('summarizeRecipeForwardedEnv', () => {
  it('returns names only, grouping the ones that look like credentials', () => {
    const summary = summarizeRecipeForwardedEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GITHUB_TOKEN: 'ghp_secret_value',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
      DB_PASSWORD: 'hunter2',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      openai_api_key: 'sk-lower',
      KEYCHAIN_PATH: '/tmp/k',
      UNSET: undefined
    })
    expect(summary).toEqual({
      count: 8,
      keyLike: [
        'ANTHROPIC_BASE_URL',
        'AWS_SECRET_ACCESS_KEY',
        'DB_PASSWORD',
        'GITHUB_TOKEN',
        'openai_api_key'
      ],
      other: ['HOME', 'KEYCHAIN_PATH', 'PATH']
    })
    expect(JSON.stringify(summary)).not.toMatch(
      /ghp_secret_value|aws-secret-value|hunter2|sk-lower/
    )
  })
})
