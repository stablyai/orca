import { afterEach, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

// #22657: deleting or ignoring it would leave the session with no resume handle at all.
it('reopens a slept agent whose tab is gone in a fresh tab and retires main’s record', async () => {
  const retireStrandedSleepRecord = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { worktrees: { retireStrandedSleepRecord } } })
  const record: SleepingAgentSessionRecord = {
    paneKey: makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111'),
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    restoreOnTabOpenOnly: true
  }
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)

  expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  const state = useAppStore.getState()
  const resumedTab = state.tabsByWorktree['wt-1']?.[0]
  expect(state.pendingStartupByTabId[resumedTab!.id]?.resumeProviderSession).toEqual(
    record.providerSession
  )
  expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  await vi.waitFor(() =>
    expect(retireStrandedSleepRecord).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      paneKey: record.paneKey
    })
  )
})
