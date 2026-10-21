import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_TAB_ID = 'web-terminal-host-tab'

afterEach(() => useAppStore.setState(initialState, true))

function makeRecord(
  worktreeId: string,
  paneKey: string,
  tabId?: string
): SleepingAgentSessionRecord {
  return {
    paneKey,
    ...(tabId ? { tabId } : {}),
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'host-conversation' },
    origin: 'live',
    state: 'working',
    prompt: 'continue',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe.each(['repo-1::/workspace/repo', 'folder:workspace'])('%s', (worktreeId) => {
  it.each([
    { paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID), tabId: HOST_TAB_ID },
    { paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID), tabId: undefined },
    { paneKey: `${HOST_TAB_ID}:0`, tabId: undefined }
  ])('preserves an absent host record $paneKey without a catalog owner', ({ paneKey, tabId }) => {
    const record = makeRecord(worktreeId, paneKey, tabId)
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: { [paneKey]: record },
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {}
    })

    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree[worktreeId]).toEqual([])
    expect(state.sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
    expect(state.automaticAgentResumeClaimsByTabId).toEqual({})
    expect(state.pendingStartupByTabId).toEqual({})
  })

  it('still recovers an ordinary terminal record with no preserved tab', () => {
    const record = makeRecord(worktreeId, makePaneKey('local-tab', LEAF_ID), 'local-tab')
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {}
    })

    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toHaveLength(1)
  })

  it('still clears completed mirror history whose pane is gone', () => {
    const record = {
      ...makeRecord(worktreeId, makePaneKey(HOST_TAB_ID, LEAF_ID), HOST_TAB_ID),
      state: 'done' as const
    }
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {}
    })

    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({})
    expect(state.tabsByWorktree[worktreeId]).toEqual([])
    expect(state.pendingStartupByTabId).toEqual({})
  })

  it('does not recover a native record that shares its session with an older mirror', () => {
    const mirrored = makeRecord(worktreeId, makePaneKey(HOST_TAB_ID, LEAF_ID), HOST_TAB_ID)
    const native = {
      ...makeRecord(worktreeId, makePaneKey('native-tab', LEAF_ID), 'native-tab'),
      capturedAt: 2,
      updatedAt: 2
    }
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: {
        [mirrored.paneKey]: mirrored,
        [native.paneKey]: native
      },
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {}
    })

    // The mirror may name a transcript its host still writes (#29421); a second sweep must agree.
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    const state = useAppStore.getState()
    // The mirror speaks for the session; the native sibling is the duplicate.
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({ [mirrored.paneKey]: mirrored })
    expect(state.tabsByWorktree[worktreeId]).toEqual([])
    expect(state.automaticAgentResumeClaimsByTabId).toEqual({})
    expect(state.pendingStartupByTabId).toEqual({})
  })
})
