import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GROK_ENCODED_CWD_DIR_MAX_BYTES,
  buildGrokChatHistoryPathCandidates,
  findGrokChatHistoryBySessionIdSync,
  grokEncodedCwdDirName,
  resolveGrokChatHistoryPathSync,
  resolveGrokHomeDir,
  resolveGrokSessionsDir
} from './grok-session-paths'

const tempDirs: string[] = []

afterEach(() => {
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
  it('honors GROK_HOME for home and sessions roots', () => {
    const root = makeRoot()
    expect(resolveGrokHomeDir({ GROK_HOME: root }, '/unused')).toBe(root)
    expect(resolveGrokSessionsDir({ GROK_HOME: root }, '/unused')).toBe(join(root, 'sessions'))
    expect(resolveGrokHomeDir({}, '/home/ada')).toBe(join('/home/ada', '.grok'))
  })

  it('refuses to invent encodeURIComponent names longer than 255 bytes', () => {
    const longCwd = `/${'a'.repeat(200)}/${'b'.repeat(200)}`
    expect(Buffer.byteLength(encodeURIComponent(longCwd), 'utf8')).toBeGreaterThan(
      GROK_ENCODED_CWD_DIR_MAX_BYTES
    )
    expect(grokEncodedCwdDirName(longCwd)).toBeNull()
    expect(
      buildGrokChatHistoryPathCandidates({
        sessionId: 'sess-1',
        cwd: longCwd,
        sessionsDir: '/tmp/sessions'
      })
    ).toEqual([])
  })

  it('resolves via encodeURIComponent(cwd) when the short path exists', () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const cwd = '/tmp/work'
    const sessionId = 'sess-short'
    const history = join(
      sessionsDir,
      encodeURIComponent(cwd),
      sessionId,
      'chat_history.jsonl'
    )
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(history, '{"type":"user"}\n')

    expect(
      resolveGrokChatHistoryPathSync({
        sessionId,
        cwd,
        sessionsDir
      })
    ).toBe(history)
  })

  it('finds chat_history by session id under a long-cwd slug group', () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const sessionId = 'sess-long'
    // Simulate Grok's slug+hash group directory (not encodeURIComponent of cwd).
    const slugGroup = 'long-path-ab12cd34'
    const history = join(sessionsDir, slugGroup, sessionId, 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(join(sessionsDir, slugGroup, '.cwd'), '/very/long/path\n')
    writeFileSync(history, '{"type":"assistant","content":"hi"}\n')

    expect(findGrokChatHistoryBySessionIdSync(sessionsDir, sessionId)).toBe(history)
    expect(
      resolveGrokChatHistoryPathSync({
        sessionId,
        cwd: `/${'x'.repeat(300)}`,
        sessionsDir
      })
    ).toBe(history)
  })

  it('finds sessions under GROK_HOME without a cwd on the payload', () => {
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
    ).toBe(history)
  })
})
