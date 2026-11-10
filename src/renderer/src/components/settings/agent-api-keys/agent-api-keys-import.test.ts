import { describe, expect, it } from 'vitest'
import { defaultImportSelection, signInProviderLabel } from './agent-api-keys-import'

describe('agent API key import helpers', () => {
  it('checks every found key the vault does not already hold', () => {
    expect(
      defaultImportSelection({
        keys: [
          {
            name: 'OPENAI_API_KEY',
            agent: 'codex',
            source: 'shell-env',
            hint: 'a1B2',
            alreadySaved: false
          },
          {
            name: 'GEMINI_API_KEY',
            agent: 'gemini',
            source: 'gemini-env-file',
            hint: 'Zk19',
            alreadySaved: true
          }
        ],
        signIns: []
      })
    ).toEqual(['OPENAI_API_KEY'])
  })

  it('labels known sign-in providers', () => {
    expect(signInProviderLabel({ agent: 'opencode', provider: 'github-copilot' })).toBe(
      'GitHub Copilot'
    )
    expect(signInProviderLabel({ agent: 'opencode', provider: 'xai' })).toBe('xai')
  })
})
