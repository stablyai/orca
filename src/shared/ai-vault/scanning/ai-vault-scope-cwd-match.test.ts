import { describe, expect, it } from 'vitest'
import { aiVaultSessionInScope, createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'

const SCOPE = ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\ada\\inbox']

describe('createAiVaultScopeCwdMatcher WSL workspace association', () => {
  it('assigns a Windows-store transcript with a native Linux cwd to the WSL workspace', () => {
    // #42369: ~/.omp is symlinked into C:\Users, so the scan finds a drive-path transcript whose cwd is native.
    const inScope = createAiVaultScopeCwdMatcher(SCOPE)
    expect(
      aiVaultSessionInScope(inScope, {
        cwd: '/home/ada/inbox',
        filePath: 'C:\\Users\\ada\\.omp\\agent\\sessions\\-home-ada-inbox\\s-1.jsonl'
      })
    ).toBe(true)
  })

  it('keeps distro proof for a transcript stored under another distro', () => {
    const inScope = createAiVaultScopeCwdMatcher(SCOPE)
    expect(
      aiVaultSessionInScope(inScope, {
        cwd: '/home/ada/inbox',
        filePath: '\\\\wsl.localhost\\Debian\\home\\ada\\.omp\\agent\\sessions\\s-1.jsonl'
      })
    ).toBe(false)
  })

  it('keeps distro proof for a POSIX store that any Linux host could own', () => {
    const inScope = createAiVaultScopeCwdMatcher(SCOPE)
    expect(
      aiVaultSessionInScope(inScope, {
        cwd: '/home/ada/inbox',
        filePath: '/home/ada/.claude/projects/-home-ada-inbox/s-1.jsonl'
      })
    ).toBe(false)
  })

  it('admits a transcript of the workspace distro by its Linux tail', () => {
    const inScope = createAiVaultScopeCwdMatcher(SCOPE)
    expect(
      aiVaultSessionInScope(inScope, {
        cwd: '/home/ada/inbox/packages',
        filePath: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\ada\\.claude\\projects\\x\\s-1.jsonl'
      })
    ).toBe(true)
  })

  it('admits a drvfs cwd to a UNC drvfs scope without distro proof', () => {
    const inScope = createAiVaultScopeCwdMatcher(['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src'])
    expect(inScope('/mnt/c/src/app', 'C:\\store\\t.jsonl')).toBe(true)
  })

  it('rejects a native Linux cwd outside the workspace tail', () => {
    const inScope = createAiVaultScopeCwdMatcher(SCOPE)
    expect(inScope('/home/ada/other', 'C:\\Users\\ada\\.omp\\agent\\sessions\\s-1.jsonl')).toBe(
      false
    )
  })
})
