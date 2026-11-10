import { describe, expect, it } from 'vitest'
import { defaultImportSelection, isMacPlatform, signInProviderLabel } from './agent-api-keys-import'

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

  it('says "this Mac" only on macOS', () => {
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })

  it('labels known sign-in providers', () => {
    expect(signInProviderLabel({ agent: 'opencode', provider: 'github-copilot' })).toBe(
      'GitHub Copilot'
    )
    expect(signInProviderLabel({ agent: 'opencode', provider: 'xai' })).toBe('xai')
  })
})
