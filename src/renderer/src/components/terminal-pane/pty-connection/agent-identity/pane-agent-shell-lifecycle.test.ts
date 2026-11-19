import { beforeEach, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { toAppSshPtyId } from '../../../../../../shared/remote-runtime/ssh/ssh-pty-id'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

const suppressedPtyExitIds: Record<string, true> = {}
const state = {
  suppressedPtyExitIds,
  agentStatusByPaneKey: new Map(),
  clearAgentLaunchConfig: vi.fn()
}
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))

const { settlePaneShellForeground } = await import('./pane-agent-shell-lifecycle')

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'woken-codex' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep'
}

function paneOn(ptyId: string, wake?: { record: SleepingAgentSessionRecord; ptyId: string }) {
  const pane = {
    transport: { getPtyId: () => ptyId },
    getSleepingRecordForPane: () => ({ paneKey: record.paneKey, record }),
    hibernatedWakeTarget: wake,
    cacheKey: record.paneKey,
    pane: { leafId: 'leaf-1' },
    deps: { onAgentExitedRef: { current: vi.fn() } },
    clearSleepingRecordProviderDuplicates: vi.fn(),
    clearStaleAgentTabTitleOnConfirmedShell: vi.fn(),
    writeInputModeGround: vi.fn(),
    reconcileEndedProcessIfPaneQuiet: vi.fn(),
    settleDeferredCommandFinishedStatusDrop: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlePaneShellForeground reads only these session members.
  return { pane, session: pane as unknown as ConnectPanePtySession }
}

beforeEach(() => {
  state.suppressedPtyExitIds = {}
})

it('retires a woken SSH agent when its shell comes back, as no host proof reaches main', () => {
  const ssh = toAppSshPtyId('conn-1', 'pty-7')
  const quit = paneOn(ssh)
  settlePaneShellForeground(quit.session, 'command-finished')
  expect(quit.pane.clearSleepingRecordProviderDuplicates).toHaveBeenCalledOnce()
  // The sleep's own kill keeps the wake record it is about to resume.
  const sleeping = paneOn(ssh, { record, ptyId: ssh })
  settlePaneShellForeground(sleeping.session, 'command-finished')
  expect(sleeping.pane.clearSleepingRecordProviderDuplicates).not.toHaveBeenCalled()
  // A local pane waits for main's shell-alone proof instead.
  const local = paneOn('pty-local')
  settlePaneShellForeground(local.session, 'command-finished')
  expect(local.pane.clearSleepingRecordProviderDuplicates).not.toHaveBeenCalled()
})
