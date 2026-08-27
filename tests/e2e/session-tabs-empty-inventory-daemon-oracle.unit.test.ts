import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '../../src/main/daemon/session-subprocess-handle'
import { TerminalHost } from '../../src/main/daemon/terminal-host'

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '../../src/renderer/src/store/slices/runtime-status'
import {
  hasHostSessionMirrorHydrated,
  parkUntilHostSessionMirrorHydrates,
  resetHostSessionMirrorHydrationForTests
} from '../../src/renderer/src/runtime/host-session-mirror-hydration'
import { clearHostLiveTerminalProbesForTests } from '../../src/renderer/src/runtime/host-live-terminal-probe'
import { replaceRuntimeEnvironmentRevisions } from '../../src/renderer/src/runtime/runtime-environment-revision'
import { applyWebSessionTabsStorePatch } from '../../src/renderer/src/runtime/web-session-tabs-sync'

const ENVIRONMENT_ID = 'env-live-unpublished'
const WORKTREE = 'repo1::/path/wt1'

type WriterSubprocess = SubprocessHandle & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  exit: () => void
}

function createWriterSubprocess(pid: number): WriterSubprocess {
  let onExit: ((code: number) => void) | null = null
  const write = vi.fn<(data: string) => void>()
  return {
    pid,
    getForegroundProcess: () => 'codex',
    write,
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    exit: () => onExit?.(0)
  }
}

describe('unpublished empty inventory daemon oracle', () => {
  beforeEach(() => {
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    clearHostLiveTerminalProbesForTests()
    replaceRuntimeEnvironmentRevisions([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the resume dispatch parked and exactly one daemon writer live', async () => {
    const subprocesses: ReturnType<typeof createWriterSubprocess>[] = []
    const host = new TerminalHost({
      spawnSubprocess: () => {
        const subprocess = createWriterSubprocess(90_000 + subprocesses.length)
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    await host.createOrAttach({
      sessionId: 'original-live-session',
      cols: 80,
      rows: 24,
      launchAgent: 'codex',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const call = vi.fn(async () => ({
      ok: true,
      result: {
        terminals: host.listSessions().map(({ sessionId }) => ({
          handle: sessionId,
          worktreeId: WORKTREE,
          connected: true
        })),
        totalCount: host.listSessions().length,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      }
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    let resumeSweeps = 0
    let replacement: Promise<unknown> | null = null
    parkUntilHostSessionMirrorHydrates(ENVIRONMENT_ID, WORKTREE, () => {
      resumeSweeps += 1
      replacement = host.createOrAttach({
        sessionId: 'replacement-resume-session',
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    })

    applyWebSessionTabsStorePatch(() => ({}), {
      frames: [],
      fullInventory: { environmentId: ENVIRONMENT_ID, publishedSnapshotCount: 0 }
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await (replacement ?? Promise.resolve())

    const liveSessionIds = host.listSessions().map(({ sessionId }) => sessionId)
    for (const sessionId of liveSessionIds) {
      host.write(sessionId, `writer:${sessionId}`)
    }

    expect({
      resumeSweeps,
      mirrorHydrated: hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE),
      liveSessionIds,
      subprocessPids: subprocesses.map(({ pid }) => pid),
      writerCalls: subprocesses.map(({ write }) => write.mock.calls)
    }).toEqual({
      resumeSweeps: 0,
      mirrorHydrated: false,
      liveSessionIds: ['original-live-session'],
      subprocessPids: [90_000],
      writerCalls: [[['writer:original-live-session']]]
    })
    expect(call).toHaveBeenCalledOnce()
    for (const subprocess of subprocesses) {
      subprocess.exit()
    }
    await host.dispose()
  })

  it('settles an authoritative empty inventory and releases the dispatch without a probe', async () => {
    const call = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    let resumeSweeps = 0
    parkUntilHostSessionMirrorHydrates(ENVIRONMENT_ID, WORKTREE, () => {
      resumeSweeps += 1
    })

    applyWebSessionTabsStorePatch(() => ({}), {
      frames: [],
      fullInventory: {
        environmentId: ENVIRONMENT_ID,
        publishedSnapshotCount: 0,
        authoritative: true
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect({
      resumeSweeps,
      mirrorHydrated: hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE),
      probeCalls: call.mock.calls.length
    }).toEqual({ resumeSweeps: 1, mirrorHydrated: true, probeCalls: 0 })
  })

  it('records legacy unconditional empty hydration releasing the resume dispatch', async () => {
    const subprocesses: ReturnType<typeof createWriterSubprocess>[] = []
    const host = new TerminalHost({
      spawnSubprocess: () => {
        const subprocess = createWriterSubprocess(90_000 + subprocesses.length)
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    await host.createOrAttach({
      sessionId: 'original-live-session',
      cols: 80,
      rows: 24,
      launchAgent: 'codex',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    // Legacy hosts answer the liveness probe with a scoped zero-terminal census.
    const call = vi.fn(async () => ({
      ok: true,
      result: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['runtime:env'], omittedHostIds: [] }
      }
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    let resumeSweeps = 0
    let replacement: Promise<unknown> | null = null
    parkUntilHostSessionMirrorHydrates(ENVIRONMENT_ID, WORKTREE, () => {
      resumeSweeps += 1
      replacement = host.createOrAttach({
        sessionId: 'replacement-resume-session',
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    })

    applyWebSessionTabsStorePatch(() => ({}), {
      frames: [],
      fullInventory: { environmentId: ENVIRONMENT_ID, publishedSnapshotCount: 0 }
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await (replacement ?? Promise.resolve())

    const liveSessionIds = host.listSessions().map(({ sessionId }) => sessionId)
    for (const sessionId of liveSessionIds) {
      host.write(sessionId, `writer:${sessionId}`)
    }

    expect({
      resumeSweeps,
      mirrorHydrated: hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE),
      liveSessionIds,
      subprocessPids: subprocesses.map(({ pid }) => pid),
      writerCalls: subprocesses.map(({ write }) => write.mock.calls)
    }).toEqual({
      resumeSweeps: 1,
      mirrorHydrated: true,
      liveSessionIds: ['original-live-session', 'replacement-resume-session'],
      subprocessPids: [90_000, 90_001],
      writerCalls: [[['writer:original-live-session']], [['writer:replacement-resume-session']]]
    })
    expect(call).toHaveBeenCalledOnce()
    for (const subprocess of subprocesses) {
      subprocess.exit()
    }
    await host.dispose()
  })
})
