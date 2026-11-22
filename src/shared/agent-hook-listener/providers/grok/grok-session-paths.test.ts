import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGrokChatHistoryPathCandidates,
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId,
  grokEncodedCwdDirName,
  isSafeGrokSessionId,
  resolveGrokChatHistoryPathSync,
  resolveGrokHomeDir,
  resolveGrokSessionsDir
} from './grok-session-paths'

const tempDirs: string[] = []

afterEach(() => {
  clearGrokSessionPathLookupCacheForTests()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-grok-session-paths-'))
  tempDirs.push(dir)
  return dir
}

describe('grok-session-paths', () => {
  // Relative GROK_HOME depends on each terminal/main/daemon cwd and can trigger unbounded scans (#13082).
  // Grok 1.0.30 also treats ~ literally rather than expanding it.
  it.each(['.', '..', 'rel/path', '~/grok', '~', 'C:foo', 'C:'])(
    'ignores the non-absolute GROK_HOME %j',
    (relativeHome) => {
      expect(resolveGrokHomeDir({ GROK_HOME: relativeHome }, '/home/ada')).toBe(
        join('/home/ada', '.grok')
      )
      expect(resolveGrokSessionsDir({ GROK_HOME: relativeHome }, '/home/ada')).toBe(
        join('/home/ada', '.grok', 'sessions')
      )
    }
  )

  it.each([
    [`/Users/test/${'中'.repeat(30)}`, 'workspace-43f12fb9a5ee1037'],
    [
      '/Users/dev/Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch',
      'main-branch-6aaeefdde2a621aa'
    ],
    [`/${'a'.repeat(260)}/My Workspace  `, 'my-workspace-821ab64a500ab620'],
    [`/${'a'.repeat(260)}/İProject`, 'i-project-a676b9c62bbe86c8'],
    [`/${'a'.repeat(260)}/${'A'.repeat(39)} !! end`, `${'a'.repeat(39)}--6306ef8d209ddda1`]
  ])('matches the raw UTF8 cwd vector %s', (cwd, expected) => {
    expect(grokEncodedCwdDirName(cwd)).toBe(expected)
  })

  it('matches the CLI URL encoding and switches layouts only beyond 255 bytes', () => {
    expect(grokEncodedCwdDirName("/repo/!'()*")).toBe('%2Frepo%2F%21%27%28%29%2A')
    expect(grokEncodedCwdDirName(`/${'a'.repeat(252)}`)).toBe(`%2F${'a'.repeat(252)}`)
    expect(grokEncodedCwdDirName(`/${'a'.repeat(253)}`)).toMatch(/^a{40}-[a-f0-9]{16}$/)
  })

  it('rejects unsafe session ids and path-special cwd components', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const invalidIds = ['../escape', 'nested/id', 'nested\\id', '.', '..', 'x'.repeat(129)]

    for (const sessionId of invalidIds) {
      expect(isSafeGrokSessionId(sessionId)).toBe(false)
      expect(buildGrokChatHistoryPathCandidates({ sessionId, cwd: '/repo', sessionsDir })).toEqual(
        []
      )
      await expect(findGrokChatHistoryBySessionId(sessionsDir, sessionId)).resolves.toBeNull()
    }

    expect(isSafeGrokSessionId('019e37f4-5135-7b63-a4ab-6d13aa6bf528')).toBe(true)
    expect(grokEncodedCwdDirName('.')).toBeNull()
    expect(grokEncodedCwdDirName('..')).toBeNull()
    expect(
      buildGrokChatHistoryPathCandidates({ sessionId: 'safe-id', cwd: '..', sessionsDir })
    ).toEqual([])
  })

  it('resolves the CLI long-cwd slug group', () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const sessionId = 'sess-long'
    // Simulate Grok's slug+hash group directory (not encodeURIComponent of cwd).
    const slugGroup = `${'x'.repeat(40)}-bc763004a2f1ee5a`
    const history = join(sessionsDir, slugGroup, sessionId, 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(join(sessionsDir, slugGroup, '.cwd'), `/${'x'.repeat(300)}\n`)
    writeFileSync(history, '{"type":"assistant","content":"hi"}\n')

    expect(
      resolveGrokChatHistoryPathSync({
        sessionId,
        cwd: `/${'x'.repeat(300)}`,
        sessionsDir
      })
    ).toBe(history)
  })

  it('does not descend below the documented group/session layout', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const nestedDecoy = join(
      sessionsDir,
      'group',
      'other-session',
      'cache',
      'sess-target',
      'chat_history.jsonl'
    )
    mkdirSync(dirname(nestedDecoy), { recursive: true })
    writeFileSync(nestedDecoy, '{}\n')

    expect(
      resolveGrokChatHistoryPathSync({
        sessionId: 'sess-target',
        cwd: '/group',
        sessionsDir
      })
    ).toBeNull()
    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-target')).resolves.toBeNull()
  })

  it('does not synchronously scan sessions when cwd is absent', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const sessionId = 'sess-env'
    const history = join(sessionsDir, encodeURIComponent('/repo'), sessionId, 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(history, '{}\n')

    expect(
      resolveGrokChatHistoryPathSync({
        sessionId,
        sessionsDir,
        env: { GROK_HOME: root }
      })
    ).toBeNull()
    await expect(findGrokChatHistoryBySessionId(sessionsDir, sessionId)).resolves.toBe(history)
  })
})
