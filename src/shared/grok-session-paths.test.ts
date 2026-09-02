import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GROK_ENCODED_CWD_DIR_MAX_BYTES,
  GROK_SESSION_SCAN_ACTIVE_ROOT_MAX,
  GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES,
  buildGrokChatHistoryPathCandidates,
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId,
  getCachedGrokChatHistoryBySessionId,
  grokEncodedCwdDirName,
  isGrokChatHistoryPath,
  isSafeGrokSessionId,
  resolveGrokChatHistoryPathSync,
  resolveGrokHomeDir,
  resolveGrokSessionsDir,
  setGrokSessionDirectoryOpenerForTests,
  setGrokSessionPathScannerForTests
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: Error) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
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
      expect(isGrokChatHistoryPath('/repo/chat_history.jsonl', sessionId)).toBe(false)
    }

    expect(isSafeGrokSessionId('019e37f4-5135-7b63-a4ab-6d13aa6bf528')).toBe(true)
    expect(grokEncodedCwdDirName('.')).toBeNull()
    expect(grokEncodedCwdDirName('..')).toBeNull()
    expect(
      buildGrokChatHistoryPathCandidates({ sessionId: 'safe-id', cwd: '..', sessionsDir })
    ).toEqual([])
  })

  it('resolves via encodeURIComponent(cwd) when the short path exists', () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const cwd = '/tmp/work'
    const sessionId = 'sess-short'
    const history = join(sessionsDir, encodeURIComponent(cwd), sessionId, 'chat_history.jsonl')
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

  it('does not synchronously discover a long-cwd slug group', () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const sessionId = 'sess-long'
    // Simulate Grok's slug+hash group directory (not encodeURIComponent of cwd).
    const slugGroup = 'long-path-ab12cd34'
    const history = join(sessionsDir, slugGroup, sessionId, 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(join(sessionsDir, slugGroup, '.cwd'), '/very/long/path\n')
    writeFileSync(history, '{"type":"assistant","content":"hi"}\n')

    expect(
      resolveGrokChatHistoryPathSync({
        sessionId,
        cwd: `/${'x'.repeat(300)}`,
        sessionsDir
      })
    ).toBeNull()
  })

  it('finds the documented group/session layout asynchronously', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const history = join(sessionsDir, 'slug-hash', 'sess-async', 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(history, '{}\n')

    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-async')).resolves.toBe(history)
  })

  it('deduplicates concurrent async discovery', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const history = join(sessionsDir, 'slug-hash', 'sess-deduped', 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(history, '{}\n')

    const first = findGrokChatHistoryBySessionId(sessionsDir, 'sess-deduped')
    const second = findGrokChatHistoryBySessionId(sessionsDir, 'sess-deduped')

    expect(second).toBe(first)
    await expect(first).resolves.toBe(history)
  })

  it('reuses a successful discovery from cache without another scan', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    const history = join(sessionsDir, 'slug-hash', 'sess-cached', 'chat_history.jsonl')
    mkdirSync(dirname(history), { recursive: true })
    writeFileSync(history, '{}\n')

    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-cached')).resolves.toBe(history)
    rmSync(join(sessionsDir, 'slug-hash'), { recursive: true, force: true })

    expect(getCachedGrokChatHistoryBySessionId(sessionsDir, 'sess-cached')).toBe(history)
    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-cached')).resolves.toBe(history)
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

  it('applies the hard group-entry bound to the filesystem iteration subset', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'sessions')
    for (const group of ['a-group', 'b-group']) {
      mkdirSync(join(sessionsDir, group), { recursive: true })
    }
    const beyondBound = join(sessionsDir, 'z-target-group', 'sess-bounded', 'chat_history.jsonl')
    mkdirSync(dirname(beyondBound), { recursive: true })
    writeFileSync(beyondBound, '{}\n')
    setGrokSessionDirectoryOpenerForTests(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const name of ['a-group', 'b-group', 'z-target-group']) {
          yield {
            name,
            isDirectory: () => true,
            isSymbolicLink: () => false
          }
        }
      },
      async close() {}
    }))

    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-bounded', 2)).resolves.toBeNull()
    await expect(findGrokChatHistoryBySessionId(sessionsDir, 'sess-bounded', 3)).resolves.toBe(
      beyondBound
    )
  })

  it('stops the directory iterator after the exact eligible-entry cap and closes it', async () => {
    let yielded = 0
    let closed = 0
    const entries = [
      { name: 'file', directory: false, symlink: false },
      { name: 'group-a', directory: true, symlink: false },
      { name: 'group-b', directory: true, symlink: false },
      { name: 'group-c', directory: true, symlink: false }
    ]
    setGrokSessionDirectoryOpenerForTests(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const entry of entries) {
          yielded += 1
          yield {
            name: entry.name,
            isDirectory: () => entry.directory,
            isSymbolicLink: () => entry.symlink
          }
        }
      },
      async close() {
        closed += 1
      }
    }))

    await expect(
      findGrokChatHistoryBySessionId('/missing/sessions', 'sess-iterator', 2)
    ).resolves.toBeNull()

    expect(yielded).toBe(3)
    expect(closed).toBe(1)
  })

  it('deduplicates the exact promise while a scanner is deferred', async () => {
    const scan = deferred<string | null>()
    let calls = 0
    setGrokSessionPathScannerForTests(async () => {
      calls += 1
      return scan.promise
    })

    const first = findGrokChatHistoryBySessionId('/sessions/a', 'sess-same')
    const second = findGrokChatHistoryBySessionId('/sessions/a', 'sess-same')
    expect(second).toBe(first)
    expect(calls).toBe(1)

    scan.resolve(null)
    await expect(first).resolves.toBeNull()
  })

  it('runs at most one scan per sessions root', async () => {
    const scans = new Map<string, ReturnType<typeof deferred<string | null>>>()
    const started: string[] = []
    setGrokSessionPathScannerForTests(async (root, sessionId) => {
      const key = `${root}:${sessionId}`
      started.push(key)
      const scan = deferred<string | null>()
      scans.set(key, scan)
      return scan.promise
    })

    const first = findGrokChatHistoryBySessionId('/sessions/root', 'sess-1')
    const second = findGrokChatHistoryBySessionId('/sessions/root', 'sess-2')
    expect(started).toEqual(['/sessions/root:sess-1'])

    scans.get('/sessions/root:sess-1')?.resolve(null)
    await first
    expect(started).toEqual(['/sessions/root:sess-1', '/sessions/root:sess-2'])
    scans.get('/sessions/root:sess-2')?.resolve(null)
    await second
  })

  it('caps active roots globally and drains queued roots in FIFO order', async () => {
    const scans = new Map<string, ReturnType<typeof deferred<string | null>>>()
    const started: string[] = []
    setGrokSessionPathScannerForTests(async (root) => {
      started.push(root)
      const scan = deferred<string | null>()
      scans.set(root, scan)
      return scan.promise
    })
    const roots = Array.from(
      { length: GROK_SESSION_SCAN_ACTIVE_ROOT_MAX + 2 },
      (_, index) => `/sessions/root-${index}`
    )
    const lookups = roots.map((root, index) =>
      findGrokChatHistoryBySessionId(root, `sess-${index}`)
    )

    expect(started).toEqual(roots.slice(0, GROK_SESSION_SCAN_ACTIVE_ROOT_MAX))
    scans.get(roots[0])?.resolve(null)
    await lookups[0]
    expect(started.at(-1)).toBe(roots[GROK_SESSION_SCAN_ACTIVE_ROOT_MAX])
    scans.get(roots[1])?.resolve(null)
    await lookups[1]
    expect(started.at(-1)).toBe(roots[GROK_SESSION_SCAN_ACTIVE_ROOT_MAX + 1])

    for (const root of roots.slice(2)) {
      scans.get(root)?.resolve(null)
    }
    await Promise.all(lookups)
  })

  it('resolves queue overflow to null and drains the bounded queue', async () => {
    const firstScan = deferred<string | null>()
    let calls = 0
    setGrokSessionPathScannerForTests(async () => {
      calls += 1
      return calls === 1 ? firstScan.promise : null
    })
    const active = findGrokChatHistoryBySessionId('/sessions/overflow', 'sess-active')
    const queued = Array.from({ length: GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES }, (_, index) =>
      findGrokChatHistoryBySessionId('/sessions/overflow', `sess-queued-${index}`)
    )
    const overflow = findGrokChatHistoryBySessionId('/sessions/overflow', 'sess-overflow')

    await expect(overflow).resolves.toBeNull()
    expect(calls).toBe(1)
    firstScan.resolve(null)
    await expect(active).resolves.toBeNull()
    await expect(Promise.all(queued)).resolves.toEqual(
      Array.from({ length: GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES }, () => null)
    )
    expect(calls).toBe(1 + GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES)
  })

  it('cleans up a rejected scan and starts the next queued lookup', async () => {
    const firstScan = deferred<string | null>()
    const started: string[] = []
    setGrokSessionPathScannerForTests(async (_root, sessionId) => {
      started.push(sessionId)
      if (sessionId === 'sess-reject') {
        return firstScan.promise
      }
      return null
    })
    const rejected = findGrokChatHistoryBySessionId('/sessions/reject', 'sess-reject')
    const next = findGrokChatHistoryBySessionId('/sessions/reject', 'sess-next')

    firstScan.reject(new Error('scanner failed'))
    await expect(rejected).resolves.toBeNull()
    await expect(next).resolves.toBeNull()
    expect(started).toEqual(['sess-reject', 'sess-next'])
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
