// Kill all and Quit Completely stop this computer's sessions. A paired server's tabs are mirrors:
// closing one sends that server a user close, which stops the server's terminal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type * as WebRuntimeSessionEnvironment from '@/runtime/web-runtime-session-environment'
import type * as WebRuntimeSessionTabLifecycle from '@/runtime/web-runtime-session-tab-lifecycle'
import type * as WorktreeAgentActivationGate from '@/lib/worktree-agent-activation-gate'
import type * as Sonner from 'sonner'
import { registerQuitAndStopAllSessionsIpcBridge } from '@/hooks/ipc-events/quit-and-stop-all-sessions-ipc-bridge'
import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds
} from './kill-all-terminal-surfaces'

const SERVER = 'env-workstation'

const mocks = vi.hoisted(() => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionEnvironment>()),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('@/runtime/web-runtime-session-tab-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionTabLifecycle>()),
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab
}))

// The progress toast animates; this suite has no animation frames.
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof Sonner>()),
  toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() })
}))

vi.mock('@/lib/worktree-agent-activation-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeAgentActivationGate>()),
  waitForWorkspaceSessionReady: () => Promise.resolve(true)
}))

type TerminalRow = AppState['tabsByWorktree'][string][number]
type UnifiedRow = AppState['unifiedTabsByWorktree'][string][number]

function terminal(id: string, worktreeId: string, ptyId: string | null = null): TerminalRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial tab row; Kill all reads only id, worktreeId and ptyId.
  return { id, worktreeId, ptyId } as TerminalRow
}

function unified(id: string, entityId: string, worktreeId: string): UnifiedRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial unified tab; Kill all reads only id, entityId, worktreeId and contentType.
  return { id, entityId, worktreeId, contentType: 'terminal' } as UnifiedRow
}

/** One local workspace and two of the paired server's, as the client's window holds them. */
function seedClientWindow(): void {
  useAppStore.setState({
    activeWorktreeId: 'server-wt-b',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a seed for one field; the rest of settings comes from the live store.
    settings: { ...useAppStore.getState().settings, activeRuntimeEnvironmentId: null } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial repos; close routing reads only id and executionHostId.
    repos: [
      { id: 'local-repo', executionHostId: 'local' },
      { id: 'server-repo', executionHostId: toRuntimeExecutionHostId(SERVER) }
    ] as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial worktrees; close routing reads only id, repoId and the owner fields.
    worktreesByRepo: {
      'local-repo': [{ id: 'local-wt', repoId: 'local-repo', hostId: 'local' }],
      'server-repo': [
        { id: 'server-wt-a', repoId: 'server-repo', runtimeOwnerEnvironmentId: SERVER },
        { id: 'server-wt-b', repoId: 'server-repo', runtimeOwnerEnvironmentId: SERVER }
      ]
    } as never,
    detectedWorktreesByRepo: {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial environment; only its id is read.
    runtimeEnvironments: [{ id: SERVER }] as never,
    runtimeEnvironmentCatalogHydrated: true,
    tabsByWorktree: {
      'local-wt': [terminal('local-tab', 'local-wt')],
      // A mounted mirror carries the server's PTY id; one never shown carries none yet.
      'server-wt-a': [
        terminal('web-terminal-a1', 'server-wt-a', toRemoteRuntimePtyId('term_a1', SERVER)),
        terminal('web-terminal-a2', 'server-wt-a')
      ],
      'server-wt-b': [
        terminal('web-terminal-b1', 'server-wt-b', toRemoteRuntimePtyId('term_b1', SERVER))
      ]
    },
    unifiedTabsByWorktree: {
      'server-wt-a': [unified('u-a2', 'web-terminal-a2', 'server-wt-a')],
      'server-wt-b': [unified('u-b1', 'web-terminal-b1', 'server-wt-b')]
    },
    ptyIdsByTabId: {
      'local-tab': ['local-pty'],
      'web-terminal-a1': [toRemoteRuntimePtyId('term_a1', SERVER)],
      'web-terminal-b1': [toRemoteRuntimePtyId('term_b1', SERVER)]
    }
  })
}

function killAll(): ReturnType<typeof runKillAllTerminalSurfaces> {
  return runKillAllTerminalSurfaces(snapshotKillAllTerminalSurfaceIds(), {
    killDaemonSessions: vi.fn().mockResolvedValue({
      killedCount: 1,
      remainingCount: 0,
      killedSessionIds: ['local-pty']
    }),
    killPty: vi.fn().mockResolvedValue(undefined),
    yieldToRenderer: async () => {},
    reportSummary: vi.fn()
  })
}

function terminalTabIds(): string[] {
  return Object.values(useAppStore.getState().tabsByWorktree).flatMap((tabs) =>
    tabs.map((tab) => tab.id)
  )
}

describe('Kill all on a client paired with a server', () => {
  let previousState: AppState

  beforeEach(() => {
    previousState = useAppStore.getState()
    mocks.closeWebRuntimeSessionTab.mockReset().mockResolvedValue('applied')
    mocks.isWebRuntimeSessionActive.mockReset().mockImplementation((id) => id === SERVER)
    seedClientWindow()
  })

  afterEach(() => {
    useAppStore.setState(previousState, true)
  })

  it("leaves the server's tabs out of its targets", () => {
    expect(snapshotKillAllTerminalSurfaceIds()).toEqual(['local-tab'])
  })

  it("never sends the server a close, and keeps the server's tabs", async () => {
    const summary = await killAll()

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(terminalTabIds()).toEqual(['web-terminal-a1', 'web-terminal-a2', 'web-terminal-b1'])
    expect(summary).toMatchObject({
      targetCount: 1,
      closeAttemptCount: 1,
      absentTargetCount: 1,
      failedCloseAttemptCount: 0
    })
  })

  it('skips a server tab that resolves to the server only after the targets were taken', async () => {
    const targets = [...snapshotKillAllTerminalSurfaceIds(), 'web-terminal-a2']

    await runKillAllTerminalSurfaces(targets, {
      killDaemonSessions: vi.fn().mockResolvedValue({ killedCount: 0, remainingCount: 0 }),
      killPty: vi.fn().mockResolvedValue(undefined),
      yieldToRenderer: async () => {},
      reportSummary: vi.fn()
    })

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(terminalTabIds()).toContain('web-terminal-a2')
  })
})

describe('Quit Completely on a client paired with a server', () => {
  let previousState: AppState

  beforeEach(() => {
    previousState = useAppStore.getState()
    mocks.closeWebRuntimeSessionTab.mockReset().mockResolvedValue('applied')
    mocks.isWebRuntimeSessionActive.mockReset().mockImplementation((id) => id === SERVER)
    seedClientWindow()
    useAppStore.setState({ hydrationSucceeded: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useAppStore.setState(previousState, true)
  })

  it("stops this computer's sessions and quits without closing the server's terminals", async () => {
    const quitAfterStoppingAllSessions = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      api: {
        pty: {
          kill: vi.fn().mockResolvedValue(undefined),
          management: {
            killAll: vi.fn().mockResolvedValue({
              killedCount: 1,
              remainingCount: 0,
              killedSessionIds: ['local-pty']
            })
          }
        },
        ui: {
          onQuitAndStopAllSessions: () => () => {},
          consumePendingQuitAndStopAllSessions: () => Promise.resolve(true),
          quitAfterStoppingAllSessions
        }
      }
    })
    registerQuitAndStopAllSessionsIpcBridge([])

    await vi.waitFor(() => expect(quitAfterStoppingAllSessions).toHaveBeenCalledTimes(1))
    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(terminalTabIds()).toEqual(['web-terminal-a1', 'web-terminal-a2', 'web-terminal-b1'])
  })
})
