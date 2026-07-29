import { describe, expect, it } from 'vitest'
import {
  canOpenAiVaultSessionLogInOrca,
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath
} from './ai-vault-session-path-actions'

describe('canUseLocalAiVaultSessionPathActions', () => {
  it('allows OS path actions for local session history', () => {
    expect(canUseLocalAiVaultSessionPathActions('local')).toBe(true)
  })

  it('blocks OS path actions for non-local or unknown session history', () => {
    expect(canUseLocalAiVaultSessionPathActions('ssh:dev-box')).toBe(false)
    expect(canUseLocalAiVaultSessionPathActions('runtime:gpu-box')).toBe(false)
    expect(canUseLocalAiVaultSessionPathActions(undefined)).toBe(false)
  })
})

describe('isSyntheticAiVaultSessionPath', () => {
  it('treats OpenCode `<database>#<sessionId>` identities as synthetic', () => {
    expect(isSyntheticAiVaultSessionPath('/home/user/.opencode/db.sqlite#sess_123')).toBe(true)
  })

  it('treats ordinary JSONL/JSON transcript paths as real', () => {
    expect(isSyntheticAiVaultSessionPath('/home/user/.claude/sessions/log.jsonl')).toBe(false)
    expect(isSyntheticAiVaultSessionPath('C:\\Users\\a\\.codex\\log.json')).toBe(false)
  })
})

describe('canOpenAiVaultSessionLogInOrca', () => {
  it('allows a local, single-file, non-synthetic path', () => {
    expect(
      canOpenAiVaultSessionLogInOrca({
        filePath: '/home/user/.claude/sessions/log.jsonl',
        executionHostId: 'local'
      })
    ).toBe(true)
  })

  it('withholds blank, remote, and synthetic identities', () => {
    expect(canOpenAiVaultSessionLogInOrca({ filePath: '   ', executionHostId: 'local' })).toBe(
      false
    )
    expect(
      canOpenAiVaultSessionLogInOrca({
        filePath: '/remote/.claude/log.jsonl',
        executionHostId: 'ssh:dev-box'
      })
    ).toBe(false)
    expect(
      canOpenAiVaultSessionLogInOrca({
        filePath: '/home/user/.opencode/db.sqlite#sess_1',
        executionHostId: 'local'
      })
    ).toBe(false)
  })
})
