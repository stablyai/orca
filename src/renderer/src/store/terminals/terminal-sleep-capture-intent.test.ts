import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stageLocalPaneSleep } from './terminal-sleep-capture-intent'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { OwnedPaneAgentRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

type Sleep = CommandOf<'sleep'> & { tabId: string }
afterEach(() => vi.unstubAllGlobals())
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))
const WORKSPACE = 'repo::/capture'
const LEAF = '11111111-1111-4111-8111-111111111111'
const key = (tab: string) => `${tab}:${LEAF}`
const record = (tab: string): OwnedPaneAgentRecord => ({
  kind: 'display-only',
  paneKey: key(tab),
  tabId: tab,
  worktreeId: WORKSPACE,
  origin: 'worktree-sleep',
  capturedAt: 100,
  display: { state: 'done', prompt: tab, agentType: 'claude', updatedAt: 20, stateStartedAt: 20 },
  completion: { kind: 'passive' }
})
let authority = 'authority-1'
beforeEach(() => {
  authority = 'authority-1'
  rpc.mockReset()
  vi.stubGlobal('window', {
    api: {
      pty: {
        inspectProcess: vi.fn(async (ptyId: string) => ({
          foregroundProcess: 'claude',
          hasChildProcesses: true,
          foregroundObservation: {
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: 'non-shell',
            processName: 'claude',
            ptyId,
            ptyIncarnationId: `inc-${ptyId}`,
            authorityGeneration: authority,
            observationEpoch: 1,
            capturedAgeMs: 0
          }
        }))
      }
    }
  })
})
function harness() {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: {
      [WORKSPACE]: ['one', 'two'].map((tab) =>
        makeTab({ id: tab, worktreeId: WORKSPACE, ptyId: `pty-${tab}` })
      )
    },
    terminalLayoutsByTabId: Object.fromEntries(
      ['one', 'two'].map((tab) => [
        tab,
        {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: `pty-${tab}` }
        }
      ])
    ),
    ptyIdsByTabId: { one: ['pty-one'], two: ['pty-two'] },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  })
  let session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: WORKSPACE,
    activeTabId: 'one',
    tabsByWorktree: store.getState().tabsByWorktree,
    terminalLayoutsByTabId: store.getState().terminalLayoutsByTabId
  }
  const apply = (command: Sleep) => {
    const loaded = loadWorkspaceLayout('local', session, nameBasedLoadContext())
    const result = applyLayoutCommand(loaded.layout, command, {
      mintId: () => 'unused',
      mintLeafId: () => LEAF,
      now: () => 100
    })
    if (result.ok) {
      session = saveWorkspaceLayout({ ...loaded, layout: result.model })
    }
    return result.ok ? { ok: true, result: result.result } : { ok: false, code: result.code }
  }
  rpc.mockImplementation(async (_target, _method, params: { command: Sleep }) =>
    apply(params.command)
  )
  const stage = (tabs = ['one']) =>
    stageLocalPaneSleep(
      store.getState,
      store.setState,
      WORKSPACE,
      Object.fromEntries(tabs.map((tab) => [key(tab), record(tab)]))
    )
  return { store, stage, apply, session: () => session }
}
it('persists the pane-owned capture before stop and conditionally restores prior absence', async () => {
  const h = harness()
  const capture = await h.stage()
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]).toMatchObject({
    kind: 'display-only',
    completion: { kind: 'passive' }
  })
  expect(capture.conditionForPty('pty-one')).toMatchObject({
    target: { ptyIncarnationId: 'inc-pty-one' }
  })
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('two')]).toBeUndefined()
  await capture.settle()
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]).toBeUndefined()
  expect(h.store.getState().sleepingAgentSessionsByPaneKey[key('one')]).toBeUndefined()
})
it.each(['refusal', 'response-lost'] as const)(
  'settles both tabs after a later %s, including uncertain writes',
  async (failure) => {
    const h = harness()
    rpc.mockImplementation(async (_target, _method, { command }: { command: Sleep }) => {
      if (command.tabId === 'two' && command.records.some((entry) => entry.capturedAt === 100)) {
        if (failure === 'response-lost') {
          h.apply(command)
          throw new Error('reply lost after commit')
        }
        return { ok: false, code: 'tab_not_found' }
      }
      return h.apply(command)
    })
    await expect(h.stage(['one', 'two'])).rejects.toThrow()
    expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]).toBeUndefined()
    expect(h.session().sleepingAgentSessionsByPaneKey?.[key('two')]).toBeUndefined()
  }
)
it('does not mirror or stop a capture whose source changed while the owner reply waited', async () => {
  const h = harness()
  rpc.mockImplementationOnce(async (_target, _method, { command }: { command: Sleep }) => {
    const result = h.apply(command)
    // A genuine newer turn retires the canonical sleep before its delayed reply arrives.
    h.apply({
      ...command,
      expectedAbsentPaneKeys: undefined,
      expectedRecords: command.records,
      records: []
    })
    h.store.setState({
      agentStatusByPaneKey: {
        [key('one')]: {
          paneKey: key('one'),
          worktreeId: WORKSPACE,
          state: 'working',
          prompt: 'new turn',
          agentType: 'claude',
          updatedAt: 200,
          stateStartedAt: 200,
          stateHistory: []
        }
      }
    })
    return result
  })
  await expect(h.stage()).rejects.toThrow('sleep_capture_not_admitted')
  expect(h.store.getState().sleepingAgentSessionsByPaneKey[key('one')]).toBeUndefined()
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]).toBeUndefined()
})
it('keeps an uncertain capture when the process authority changes before settlement', async () => {
  const h = harness()
  const capture = await h.stage()
  authority = 'authority-2'
  await capture.settle()
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]).toMatchObject({
    kind: 'display-only'
  })
})
it('does not overwrite a newer pane capture during rollback', async () => {
  const h = harness()
  const capture = await h.stage()
  const newer = { ...record('one'), capturedAt: 300 }
  h.apply({
    type: 'sleep',
    workspace: WORKSPACE,
    tabId: 'one',
    paneKeys: [key('one')],
    records: [newer],
    recordOnly: true
  })
  h.store.setState({ sleepingAgentSessionsByPaneKey: { [key('one')]: newer } })
  await capture.settle()
  expect(h.session().sleepingAgentSessionsByPaneKey?.[key('one')]?.capturedAt).toBe(300)
  expect(h.store.getState().sleepingAgentSessionsByPaneKey[key('one')]?.capturedAt).toBe(300)
})
