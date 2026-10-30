import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canOpenAiVaultSessionLogInOrca,
  canUseLocalAiVaultSessionPathActions,
  isSyntheticAiVaultSessionPath,
  revealAiVaultSessionPath
} from './ai-vault-session-path-actions'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

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
  it.each<[AiVaultAgent, string]>([
    ['opencode2', '/home/user/.local/share/opencode/opencode.db'],
    ['opencode', '/home/user/.local/share/opencode/opencode-preview.db'],
    ['zcode', 'C:\\Users\\a\\.zcode\\db.sqlite'],
    ['opencode', '/home/user/.local/share/opencode/storage/session/project/ses_1.json'],
    ['kimi', '/home/user/.kimi-code/sessions/session_1/state.json'],
    ['claude', '/home/user/.claude/unrecognized.db']
  ])('withholds %s storage without a single conversation file: %s', (agent, filePath) => {
    const session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'> = {
      agent,
      filePath,
      executionHostId: 'local'
    }
    expect(canOpenAiVaultSessionLogInOrca(session)).toBe(false)
  })

  it.each<[AiVaultAgent, string]>([
    ['claude', '/home/user/.claude/sessions/log.jsonl'],
    ['gemini', '/home/user/.gemini/tmp/project/chats/session.json'],
    ['codex', '/home/user/project#1/session.jsonl']
  ])('allows a local %s conversation file: %s', (agent, filePath) => {
    expect(
      canOpenAiVaultSessionLogInOrca({
        agent,
        filePath,
        executionHostId: 'local'
      })
    ).toBe(true)
  })

  it('withholds blank, remote, and synthetic identities', () => {
    expect(
      canOpenAiVaultSessionLogInOrca({ agent: 'claude', filePath: '   ', executionHostId: 'local' })
    ).toBe(false)
    expect(
      canOpenAiVaultSessionLogInOrca({
        agent: 'claude',
        filePath: '/remote/.claude/log.jsonl',
        executionHostId: 'ssh:dev-box'
      })
    ).toBe(false)
    expect(
      canOpenAiVaultSessionLogInOrca({
        agent: 'claude',
        filePath: '/home/user/.opencode/db.sqlite#sess_1',
        executionHostId: 'local'
      })
    ).toBe(false)
  })
})

describe('revealAiVaultSessionPath', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refuses an SSH session log instead of revealing a same-named local path', async () => {
    const openInFileManager = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', { api: { shell: { openInFileManager } } })

    await revealAiVaultSessionPath({ executionHostId: 'ssh:dev-box' }, '/home/ada/.codex/log.jsonl')
    expect(openInFileManager).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()

    await revealAiVaultSessionPath({ executionHostId: 'local' }, '/Users/ada/.codex/log.jsonl')
    expect(openInFileManager).toHaveBeenCalledWith('/Users/ada/.codex/log.jsonl', 'local')
  })
})
