import { afterEach, expect, it, vi } from 'vitest'
import { projectIpcPtyConnectResult } from '../ipc-pty-connect-result'
import type { PtyConnectResult } from '../pty-transport-types'
import { bindStartFreshSpawn } from './fresh-spawn-start'
import { useAppStore } from '@/store'
import { installPaneTerminalInterfacePresentation } from './pane-terminal-interface-presentation'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'
import { armRestartReplacement, consumeRestartReplacement } from './restart-replacement-on-show'
import {
  applyTerminalInterfaceSnapshot,
  nativeChatShellForeground,
  refreshTerminalInterfacePresentation,
  readTerminalInterface,
  terminalInterfaceReleasesChat
} from '../../native-chat/terminal-interface-presentation'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { TerminalInterfaceObservation } from '../../../../../shared/terminal-interface-observation'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      terminalInterfaceByPtyId: {},
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      runtimePaneTitlesByTabId: {}
    }))
  }
})
const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((off) => off()))

it('reconciles the mounted applicable binding once, including pending clearance, reentrant title writes and actual restart intent', async () => {
  const observation: TerminalInterfaceObservation = {
    paneKey,
    ptyId: 'pty',
    incarnationId: 'birth',
    terminalHandle: 'handle',
    worktreeId: 'folder:one',
    epoch: 'pane-effects',
    revision: 1,
    inputRevision: 0,
    executionLaunchToken: null,
    owner: null,
    state: 'shell',
    basis: 'hook'
  }
  let ptyId = 'pty'
  let incarnation = 'birth'
  const title = vi.fn((_tab: string, _pane: number, next: string) => {
    useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: next } } })
  })
  const ground = vi.fn()
  const transport = { getPtyId: () => ptyId }
  const spawn = vi.fn(() => {
    session.pendingStartupCommand = 'codex --resume'
    return Promise.resolve()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all members read by the real presentation, title and restart installers are provided here.
  const session = {
    cacheKey: paneKey,
    pendingSpawnKey: paneKey,
    disposed: false,
    pendingStartupCommand: undefined,
    startupInjectTimer: null,
    transportConnectInFlightSince: null,
    transport,
    get remotePtyIncarnationId() {
      return incarnation
    },
    spawnedFreshPtyId: 'pty',
    pane: { id: 1, leafId: paneKey.slice(4) },
    manager: { getActivePane: () => ({ id: 1 }) },
    deps: {
      tabId: 'tab',
      worktreeId: 'folder:one',
      isPtyShutdownPending: () => false,
      isVisibleRef: { current: false },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      setRuntimePaneTitle: title,
      updateTabTitle: vi.fn()
    },
    neutralTerminalTitle: () => 'Terminal',
    writeInputModeGround: ground,
    spawnColdRestoreAgentResume: spawn
  } as unknown as ConnectPanePtySession
  const publish = (patch: Partial<TerminalInterfaceObservation> = {}) => {
    const next = { ...observation, ...patch }
    applyTerminalInterfaceSnapshot(
      {
        type: 'terminalInterfaces',
        epoch: next.epoch,
        revision: next.revision,
        observations: [next]
      },
      null
    )
  }
  useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'codex' } } })
  publish()
  installPaneTerminalInterfacePresentation(session)
  cleanups.push(() => session.unregisterTerminalInterfacePresentation?.())
  expect(ground).not.toHaveBeenCalled() // The identity installer assigns this method later.
  session.clearStaleAgentTabTitleOnConfirmedShell = () =>
    clearStaleAgentTabTitleOnConfirmedShell(session)
  await Promise.resolve() // Existing registration refresh, no new timer.
  expect(title).toHaveBeenCalledTimes(1)
  expect(ground).toHaveBeenCalledTimes(1)
  publish({ revision: 2, inputRevision: 10, owner: 'retired', basis: 'process' })
  useAppStore.setState({ runtimePaneTitlesByTabId: { tab: { 1: 'My workspace' } } })
  expect(ground).toHaveBeenCalledTimes(1)
  session.pendingStartupCommand = 'codex'
  refreshTerminalInterfacePresentation()
  await Promise.resolve()
  expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
  session.pendingStartupCommand = undefined
  refreshTerminalInterfacePresentation()
  await Promise.resolve()
  expect(ground).toHaveBeenCalledTimes(2)
  expect(title).toHaveBeenCalledTimes(1) // Preserve the user's title.
  publish({ revision: 3, state: 'agent' })
  publish({ revision: 4 })
  expect(ground).toHaveBeenCalledTimes(3)
  // A released old shell followed by the supported restart producer is protected immediately.
  armRestartReplacement(session, ptyId)
  await Promise.resolve()
  expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
  consumeRestartReplacement(session)
  await Promise.resolve()
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(ground).toHaveBeenCalledTimes(3)
  ptyId = 'replacement'
  incarnation = 'next'
  session.pendingStartupCommand = undefined
  publish({ revision: 5, ptyId, incarnationId: incarnation, terminalHandle: 'next-handle' })
  expect(ground).toHaveBeenCalledTimes(4)
  publish({
    epoch: 'new-authority',
    revision: 1,
    ptyId,
    incarnationId: incarnation,
    terminalHandle: 'next-handle'
  })
  expect(ground).toHaveBeenCalledTimes(5)
  session.disposed = true
  session.unregisterTerminalInterfacePresentation?.()
  publish({
    epoch: 'new-authority',
    revision: 2,
    ptyId,
    incarnationId: incarnation,
    state: 'agent'
  })
  publish({ epoch: 'new-authority', revision: 3, ptyId, incarnationId: incarnation })
  await Promise.resolve()
  expect(ground).toHaveBeenCalledTimes(5)
})

it('carries real IPC projection identity into the mounted session and releases only the matching shell lifetime', async () => {
  vi.stubGlobal('window', {
    api: { pty: { declarePendingPaneSerializer: async () => null } }
  })
  try {
    const branches: Partial<PtyConnectResult>[] = [
      {},
      { launchAgent: 'codex' },
      { launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} } },
      { isReattach: true, snapshot: 'history', snapshotSeq: 8 },
      { coldRestore: { scrollback: 'history', cwd: '/workspace' } },
      { sessionExpired: true },
      { startupCwdFallback: { kind: 'worktree', cwd: '/workspace' } },
      { agentResumeUnavailable: true }
    ]
    for (const branch of branches) {
      for (const incarnationId of ['birth', 'previous-birth', undefined]) {
        const response = { id: 'pty', ...branch, ...(incarnationId ? { incarnationId } : {}) }
        const projected = projectIpcPtyConnectResult(response)
        if (!incarnationId && Object.keys(branch).length === 0) {
          expect(projected).toBe('pty')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every member read by the real fresh-spawn and presentation installers; other terminal subsystems are inert.
        const session = {
          cacheKey: paneKey,
          pendingSpawnKey: paneKey,
          disposed: false,
          remotePtyIncarnationId: 'predecessor',
          authoritativeReattachGeneration: 0,
          transportStreamGeneration: 1,
          activePanePtyBinding: 'pty',
          spawnedFreshPtyId: 'pty',
          startupInjectTimer: null,
          transportConnectInFlightSince: null,
          pane: { terminal: { write: vi.fn() } },
          transport: { getPtyId: () => 'pty', connect: async () => projected },
          deps: {
            worktreeId: 'folder:one',
            tabId: 'tab',
            isVisibleRef: { current: false },
            isPtyShutdownPending: () => false
          },
          clearPaneMode2031State: vi.fn(),
          clearHiddenOutputRestoreState: vi.fn(),
          resetFreshSpawnFollowOutput: vi.fn(),
          writeInputModeGround: vi.fn(),
          prepareFreshShellViewportForSpawn: vi.fn(),
          shouldDeclareHiddenAtSpawn: () => false,
          captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
          finishReattachLiveDataDeferral: vi.fn(),
          handleReattachResult: async () => true,
          registerEffectiveLaunchConfig: vi.fn(),
          showSessionRestoredBanner: vi.fn(),
          clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
          reconcilePtySizeAfterSpawn: vi.fn(),
          registerPaneSerializerFor: vi.fn(),
          clearStaleAgentTabTitleOnConfirmedShell: vi.fn()
        } as unknown as ConnectPanePtySession
        useAppStore.setState({ terminalInterfaceByPtyId: {} })
        installPaneTerminalInterfacePresentation(session)
        try {
          bindStartFreshSpawn(session)
          expect(await session.startFreshSpawn()).toBe('pty')
          await Promise.resolve()
          expect(session.remotePtyIncarnationId).toBe(incarnationId ?? null)
          applyTerminalInterfaceSnapshot(
            {
              type: 'terminalInterfaces',
              epoch: 'ipc-handoff',
              revision: 1,
              observations: [
                {
                  ptyId: 'pty',
                  incarnationId: 'birth',
                  paneKey,
                  terminalHandle: 'handle',
                  worktreeId: 'folder:one',
                  epoch: 'ipc-handoff',
                  revision: 1,
                  inputRevision: 0,
                  executionLaunchToken: null,
                  owner: null,
                  state: 'shell',
                  basis: 'process'
                }
              ]
            },
            null
          )
          expect(readTerminalInterface(useAppStore.getState(), paneKey) !== null).toBe(
            incarnationId === 'birth'
          )
          expect(terminalInterfaceReleasesChat(useAppStore.getState(), paneKey)).toBe(
            incarnationId === 'birth'
          )
        } finally {
          session.disposed = true
          session.unregisterTerminalInterfacePresentation?.()
        }
      }
    }
  } finally {
    vi.unstubAllGlobals()
  }
})
