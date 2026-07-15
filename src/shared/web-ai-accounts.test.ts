import { describe, expect, it } from 'vitest'
import { WEB_AI_BROWSER_WORKSPACE_ID, isPersistentLocalWorkspaceId } from './constants'
import {
  getWebAiAccountCookieImportScope,
  getWebAiAccountHomeUrl,
  getWebAiAccountServiceLabel,
  getWebAiAccountWorkspaceId,
  getWebAiProvider,
  isWebAiAccountWorkspaceId,
  isWebAiBrowserWorkspaceId,
  normalizeWebAiAccounts,
  parseWebAiAccountWorkspaceId,
  webAiAccountMatchesWorkspace
} from './web-ai-accounts'

describe('web AI accounts', () => {
  it('normalizes valid accounts, defaults host ownership, and drops legacy project binding', () => {
    expect(
      normalizeWebAiAccounts([
        {
          id: 'account-1',
          provider: 'chatgpt',
          label: ' Personal ',
          profileId: 'profile-1',
          sessionPartition: 'persist:profile-1',
          lastWorktreeId: ' worktree-1 ',
          createdAt: 123
        }
      ])
    ).toEqual([
      {
        id: 'account-1',
        provider: 'chatgpt',
        label: 'Personal',
        executionHostId: 'local',
        profileId: 'profile-1',
        sessionPartition: 'persist:profile-1',
        createdAt: 123
      }
    ])
  })

  it('drops malformed and duplicate records', () => {
    expect(
      normalizeWebAiAccounts([
        {
          id: 'account-1',
          provider: 'claude',
          label: 'Work',
          executionHostId: 'local',
          profileId: 'profile-1',
          sessionPartition: 'persist:profile-1',
          createdAt: 1
        },
        {
          id: 'account-1',
          provider: 'deepseek',
          label: 'Duplicate',
          executionHostId: 'local',
          profileId: 'profile-2',
          sessionPartition: 'persist:profile-2',
          createdAt: 2
        },
        { id: 'bad', provider: 'unknown' }
      ])
    ).toHaveLength(1)
  })

  it('drops non-local accounts until remote Web AI surfaces exist', () => {
    expect(
      normalizeWebAiAccounts([
        {
          id: 'remote-account',
          provider: 'chatgpt',
          label: 'Remote ChatGPT',
          executionHostId: 'ssh:server-1',
          profileId: 'profile-remote',
          sessionPartition: 'persist:profile-remote',
          createdAt: 1
        }
      ])
    ).toEqual([])
  })

  it('maps each provider to its browser home', () => {
    expect(getWebAiProvider('chatgpt').homeUrl).toBe('https://chatgpt.com/')
    expect(getWebAiProvider('claude').homeUrl).toBe('https://claude.ai/')
    expect(getWebAiProvider('deepseek').homeUrl).toBe('https://chat.deepseek.com/')
    expect(getWebAiProvider('gemini')).toMatchObject({
      homeUrl: 'https://gemini.google.com/',
      hostnames: ['gemini.google.com'],
      cookieDomains: ['google.com']
    })
    expect(getWebAiProvider('aistudio')).toMatchObject({
      label: 'Google AI Studio',
      homeUrl: 'https://aistudio.google.com/',
      hostnames: ['aistudio.google.com'],
      cookieDomains: ['google.com']
    })
    expect(getWebAiProvider('custom')).toMatchObject({
      label: 'Custom',
      homeUrl: '',
      cookieDomains: []
    })
    expect(getWebAiProvider('chatgpt').cookieDomains).toEqual(['chatgpt.com', 'openai.com'])
    expect(getWebAiProvider('claude').cookieDomains).toEqual(['claude.ai', 'anthropic.com'])
    expect(getWebAiProvider('deepseek').cookieDomains).toEqual(['deepseek.com'])
  })

  it('normalizes a Doubao Custom account and derives a safe cookie scope', () => {
    const account = normalizeWebAiAccounts([
      {
        id: 'account-doubao',
        provider: 'custom',
        label: 'Personal Doubao',
        executionHostId: 'local',
        profileId: 'profile-doubao',
        sessionPartition: 'persist:profile-doubao',
        customServiceLabel: '  Doubao  ',
        customHomeUrl: 'https://www.doubao.com/chat/?token=secret#new',
        customCookieDomains: [],
        createdAt: 1
      }
    ])[0]!

    expect(account).toMatchObject({
      provider: 'custom',
      customServiceLabel: 'Doubao',
      customHomeUrl: 'https://www.doubao.com/chat/',
      customCookieDomains: ['doubao.com']
    })
    expect(getWebAiAccountServiceLabel(account)).toBe('Doubao')
    expect(getWebAiAccountHomeUrl(account)).toBe('https://www.doubao.com/chat/')
    expect(getWebAiAccountCookieImportScope(account)).toEqual({
      label: 'Doubao',
      domains: ['doubao.com'],
      sourceHostname: 'www.doubao.com'
    })
  })

  it('keeps fixed providers on the trusted provider cookie-import route', () => {
    const account = normalizeWebAiAccounts([
      {
        id: 'account-aistudio',
        provider: 'aistudio',
        label: 'Work AI Studio',
        profileId: 'profile-aistudio',
        sessionPartition: 'persist:profile-aistudio',
        createdAt: 1
      }
    ])[0]!

    expect(getWebAiAccountCookieImportScope(account)).toBeNull()
    expect(getWebAiAccountHomeUrl(account)).toBe('https://aistudio.google.com/')
  })

  it('accepts legacy flattened Custom aliases without falling back to ChatGPT', () => {
    const account = normalizeWebAiAccounts([
      {
        id: 'account-custom',
        provider: 'custom',
        label: 'Internal AI',
        profileId: 'profile-custom',
        sessionPartition: 'persist:profile-custom',
        homeUrl: 'https://chat.example.com/',
        cookieDomains: 'example.com',
        createdAt: 1
      }
    ])[0]!

    expect(account.customServiceLabel).toBe('Internal AI')
    expect(getWebAiAccountHomeUrl(account)).toBe('https://chat.example.com/')
    expect(getWebAiAccountHomeUrl(account)).not.toBe(getWebAiProvider('chatgpt').homeUrl)
  })

  it('rejects unsafe Custom homes and cookie scopes', () => {
    const base = {
      id: 'account-custom',
      provider: 'custom',
      label: 'Custom AI',
      profileId: 'profile-custom',
      sessionPartition: 'persist:profile-custom',
      customServiceLabel: 'Custom AI',
      createdAt: 1
    }

    expect(
      normalizeWebAiAccounts([{ ...base, customHomeUrl: 'http://chat.example.com/' }])
    ).toEqual([])
    expect(
      normalizeWebAiAccounts([{ ...base, customHomeUrl: 'https://user:secret@chat.example.com/' }])
    ).toEqual([])
    expect(
      normalizeWebAiAccounts([
        {
          ...base,
          customHomeUrl: 'https://chat.example.com/',
          customCookieDomains: ['google.com']
        }
      ])
    ).toEqual([])
    expect(
      normalizeWebAiAccounts([
        {
          ...base,
          customHomeUrl: 'https://chat.example.com/',
          customCookieDomains: ['com']
        }
      ])
    ).toEqual([])
  })

  it('round-trips deterministic account workspace IDs without delimiter ambiguity', () => {
    const accountId = 'account:personal:一'
    const workspaceId = getWebAiAccountWorkspaceId(accountId)

    expect(parseWebAiAccountWorkspaceId(workspaceId)).toBe(accountId)
    expect(isWebAiAccountWorkspaceId(workspaceId)).toBe(true)
    expect(isWebAiBrowserWorkspaceId(workspaceId)).toBe(true)
    expect(isWebAiBrowserWorkspaceId(WEB_AI_BROWSER_WORKSPACE_ID)).toBe(true)
    expect(isPersistentLocalWorkspaceId(workspaceId)).toBe(true)
    expect(parseWebAiAccountWorkspaceId('global-web-ai-account:2:a:b')).toBeNull()
    expect(parseWebAiAccountWorkspaceId('global-web-ai-account:01:a')).toBeNull()
    expect(parseWebAiAccountWorkspaceId('global-web-ai-account:0:')).toBeNull()
  })

  it('matches a workspace only when account, host, profile, and partition stay aligned', () => {
    const account = normalizeWebAiAccounts([
      {
        id: 'account-1',
        provider: 'chatgpt',
        label: 'Personal',
        executionHostId: 'local',
        profileId: 'profile-1',
        sessionPartition: 'persist:profile-1',
        createdAt: 1
      }
    ])[0]!
    const workspace = {
      worktreeId: getWebAiAccountWorkspaceId(account.id),
      webAiAccountId: account.id,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition
    }

    expect(webAiAccountMatchesWorkspace(account, workspace)).toBe(true)
    expect(
      webAiAccountMatchesWorkspace(account, {
        ...workspace,
        sessionPartition: 'persist:another-profile'
      })
    ).toBe(false)
    expect(
      webAiAccountMatchesWorkspace(
        account,
        { ...workspace, worktreeId: WEB_AI_BROWSER_WORKSPACE_ID },
        WEB_AI_BROWSER_WORKSPACE_ID
      )
    ).toBe(true)
  })
})
