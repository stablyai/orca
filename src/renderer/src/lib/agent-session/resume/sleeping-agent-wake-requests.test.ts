import { useAppStore } from '@/store/index'
import { installSleepingRecordAccess } from '@/components/terminal-pane/pty-connection/startup/sleeping-record-access'
import { installPaneAgentIdentity } from '@/components/terminal-pane/pty-connection/agent-identity/pane-agent-identity'
import { bindCaptureTransportOutputCallbacks } from '@/components/terminal-pane/pty-connection/lifecycle/transport-output-callbacks'
const foreground = vi.hoisted(() => ({ onShell: (_reason: 'process-exit') => {} }))
vi.mock(
  '@/components/terminal-pane/pty-connection/agent-identity/foreground-process/pane-foreground-agent-tracker',
  () => ({
    createPaneForegroundAgentTracker: (options: {
      onConfirmedShellForeground: typeof foreground.onShell
    }) => {
      foreground.onShell = options.onConfirmedShellForeground
      return {}
    }
  })
)
import {
  currentMailWakeStartup,
  paneResumeRecord,
  installPaneResumeRecord
} from '@/components/terminal-pane/pty-connection/startup/pane-resume-record'
import { hasEmptyReattachRetireEvidence } from '@/components/terminal-pane/pty-connection/reattach/empty-reattach-retire-evidence'
import type { ColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

const state = vi.hoisted(
  (): { sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> } => ({
    sleepingAgentSessionsByPaneKey: {}
  })
)
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { takeSleepingAgentWakeRequest } from './sleeping-agent-wake-requests'

it('background mail wake authorizes only its pane when a tab contains several sleeping agents', () => {
  const first: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'first' },
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    prompt: ''
  }
  const second: SleepingAgentSessionRecord = {
    ...first,
    paneKey: 'tab:22222222-2222-4222-8222-222222222222',
    providerSession: { key: 'session_id', id: 'second' }
  }
  state.sleepingAgentSessionsByPaneKey = { [first.paneKey]: first, [second.paneKey]: second }
  requestBackgroundTerminalWorktreeMount({
    worktreeId: 'workspace',
    tabIds: ['tab'],
    wakePaneKey: first.paneKey
  })
  expect(takeSleepingAgentWakeRequest(first)).toBe(true)
  expect(takeSleepingAgentWakeRequest(second)).toBe(false)
})

it('keeps pre-launch custody on its quit bookmark through an already armed wake without authorizing retirement', () => {
  const original: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conversation' },
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    prompt: ''
  }
  const retained: SleepingAgentSessionRecord = {
    ...original,
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: { id: 'obligation', capturedAt: 1, startedAt: 100 }
  }
  const startup: ColdRestoreAgentResumeStartup = {
    agent: 'codex',
    command: 'codex resume conversation',
    resumeProviderSession: original.providerSession,
    launchToken: 'this-invocation',
    resumeOrigin: 'saved',
    launchConfig: { agentArgs: '', agentEnv: {} },
    useLiveEntry: false,
    hasSleepingRecord: true,
    sleepingRecordEntry: { paneKey: original.paneKey, record: original }
  }
  const current = currentMailWakeStartup(startup, { [original.paneKey]: retained })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bookmark capture reads only pane identity, startup and the bound transport incarnation.
  const session = {
    cacheKey: original.paneKey,
    deps: { tabId: 'tab', worktreeId: 'workspace' },
    remotePtyIncarnationId: 'incarnation',
    transport: { getPtyId: () => 'pty-shell' }
  } as unknown as ConnectPanePtySession
  expect(paneResumeRecord(session, current)).toMatchObject({
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: {
      id: 'obligation',
      capturedAt: 1,
      attempt: { ptyId: 'pty-shell', incarnationId: 'incarnation', launchToken: 'this-invocation' }
    }
  })
  expect(hasEmptyReattachRetireEvidence('pty-shell', current)).toBe(false)
  const manual: SleepingAgentSessionRecord = {
    ...original,
    capturedAt: 2,
    restoreOnTabOpenOnly: true
  }
  expect(
    currentMailWakeStartup(startup, { [original.paneKey]: manual }).sleepingRecordEntry?.record
  ).toBe(original)
})

it('preserves custody through the installed spawn/alias/shell callbacks and restores only a definite prelaunch refusal', () => {
  const original: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conversation' },
    prompt: '',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1
  }
  const retained: SleepingAgentSessionRecord = {
    ...original,
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: { id: 'obligation', capturedAt: 1, startedAt: 100 }
  }
  const alias = { ...retained, paneKey: 'tab:22222222-2222-4222-8222-222222222222' }
  const replacement = {
    ...original,
    paneKey: 'tab:33333333-3333-4333-8333-333333333333',
    capturedAt: 2
  }
  state.sleepingAgentSessionsByPaneKey = {
    [original.paneKey]: retained,
    [alias.paneKey]: alias,
    [replacement.paneKey]: replacement
  }
  Object.assign(state, {
    agentLaunchConfigByPaneKey: {},
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    automaticAgentResumeClaimsByTabId: {},
    tabsByWorktree: {},
    suppressedPtyExitIds: {},
    rememberSleepingAgentSession: (
      record: SleepingAgentSessionRecord,
      expected?: SleepingAgentSessionRecord
    ) => {
      if (expected && state.sleepingAgentSessionsByPaneKey[record.paneKey] !== expected) {
        return
      }
      state.sleepingAgentSessionsByPaneKey = {
        ...state.sleepingAgentSessionsByPaneKey,
        [record.paneKey]: record
      }
    },
    clearSleepingAgentSession: (key: string) => {
      const next = { ...state.sleepingAgentSessionsByPaneKey }
      delete next[key]
      state.sleepingAgentSessionsByPaneKey = next
    },
    clearAgentLaunchConfig: vi.fn()
  })
  const transport = { getPtyId: () => 'pty-shell' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installers exercise the listed pane/store callbacks; unused transport methods are never called.
  const session = {
    cacheKey: original.paneKey,
    paneStartup: null,
    remotePtyIncarnationId: 'inc',
    transport,
    transportStreamGeneration: 0,
    disposed: false,
    pane: {
      id: 1,
      leafId: '11111111-1111-4111-8111-111111111111',
      terminal: {
        parser: { registerOscHandler: () => ({ dispose() {} }) },
        onRender: () => ({ dispose() {} })
      }
    },
    deps: {
      tabId: 'tab',
      worktreeId: 'workspace',
      isVisibleRef: { current: false },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      onAgentExitedRef: { current: vi.fn() }
    },
    writeInputModeGround: vi.fn(),
    createProcessExitState: () => ({ detector: { observe() {} } })
  } as unknown as ConnectPanePtySession
  installSleepingRecordAccess(session)
  installPaneResumeRecord(session)
  const startup: ColdRestoreAgentResumeStartup = {
    agent: 'codex',
    command: 'codex resume conversation',
    resumeProviderSession: original.providerSession,
    launchToken: 'invocation',
    resumeOrigin: 'saved',
    launchConfig: { agentArgs: '', agentEnv: {} },
    useLiveEntry: false,
    hasSleepingRecord: true,
    sleepingRecordEntry: { paneKey: original.paneKey, record: original }
  }
  session.keepResumeRecordAfterColdRestoreSpawn(startup)
  expect(state.sleepingAgentSessionsByPaneKey[original.paneKey]?.mailWake?.attempt).toEqual({
    ptyId: 'pty-shell',
    incarnationId: 'inc',
    launchToken: 'invocation',
    startedAt: 100
  })
  session.clearSleepingRecordProviderDuplicates(useAppStore.getState(), {
    paneKey: original.paneKey,
    record: original
  })
  installPaneAgentIdentity(session)
  foreground.onShell('process-exit')
  expect(state.sleepingAgentSessionsByPaneKey[original.paneKey]?.mailWake?.id).toBe('obligation')
  expect(state.sleepingAgentSessionsByPaneKey[alias.paneKey]?.mailWake?.id).toBe('obligation')
  expect(state.sleepingAgentSessionsByPaneKey[replacement.paneKey]).toBe(replacement)
  session.commandLifecycle.dispose()

  state.sleepingAgentSessionsByPaneKey = { [retained.paneKey]: retained }
  bindCaptureTransportOutputCallbacks(session)
  const capture = session.captureTransportOutputCallbacks(vi.fn(), null, startup)
  expect(state.sleepingAgentSessionsByPaneKey[retained.paneKey]?.mailWake?.id).toBe('obligation')
  capture.callbacks.onSpawnDeferred?.('paused')
  expect(state.sleepingAgentSessionsByPaneKey[retained.paneKey]).toMatchObject({
    origin: 'worktree-sleep',
    capturedAt: 1
  })
  expect(state.sleepingAgentSessionsByPaneKey[retained.paneKey]?.mailWake).toBeUndefined()
  session.startupTiming?.finish('replaced')
})
