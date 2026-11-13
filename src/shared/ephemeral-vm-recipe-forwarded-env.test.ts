import { describe, expect, it } from 'vitest'
import { listCredentialLikeEnvNames } from './ephemeral-vm-recipe-env'
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
      other: ['HOME', 'KEYCHAIN_PATH', 'PATH'],
      narrowed: false
    })
    expect(JSON.stringify(summary)).not.toMatch(
      /ghp_secret_value|aws-secret-value|hunter2|sk-lower/
    )
  })

  const env = { AWS_SECRET_ACCESS_KEY: 'aws', OPENAI_API_KEY: 'sk', PATH: '/usr/bin' }

  it("summarizes only what the recipe's passEnv lets through", () => {
    expect(summarizeRecipeForwardedEnv(env, ['AWS_*'], 'linux')).toEqual({
      count: 2,
      keyLike: ['AWS_SECRET_ACCESS_KEY'],
      other: ['PATH'],
      narrowed: true
    })
  })

  it('summarizes the whole env without passEnv', () => {
    expect(summarizeRecipeForwardedEnv(env, undefined, 'linux')).toEqual({
      count: 3,
      keyLike: ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'],
      other: ['PATH'],
      narrowed: false
    })
  })

  it('names the same credentials as the Settings credentials notice', () => {
    const sample = {
      OPENAI_API_KEY: 'v',
      GITHUB_TOKEN: 'v',
      AWS_REGION: 'v',
      MY_PASSWORD: 'v',
      ANTHROPIC_AUTH_TOKEN: 'v',
      PRIVATE_KEY_PATH: 'v',
      PATH: 'v'
    }
    const keyLike = summarizeRecipeForwardedEnv(sample).keyLike
    expect(keyLike).toEqual(listCredentialLikeEnvNames(sample))
    expect(keyLike).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'AWS_REGION',
      'GITHUB_TOKEN',
      'MY_PASSWORD',
      'OPENAI_API_KEY',
      'PRIVATE_KEY_PATH'
    ])
  })
})
