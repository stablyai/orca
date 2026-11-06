import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { resumeSleepingAgentSessionsForWorktree } from './agent-session/resume/resume-sleeping-agent-session'

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
