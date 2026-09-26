// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { wakeSleepingAgentsForWorktreeInBackground } from './wake-sleeping-agents-in-background'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecoveryRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'recovery',
    recovery: { importKey: 'import-1', sourcePaneKey: 'src-tab:src-leaf' },
    ...overrides
  }
}

function seedStore(records: SleepingAgentSessionRecord[]): void {
  useAppStore.setState({
    activeWorktreeId: 'wt-other',
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      records.map((record) => [record.paneKey, record])
    )
  })
}

describe('automatic resume sweeps skip dormant recovery bindings', () => {
  it.each(['working', 'done'] as const)(
    'leaves a %s recovery row dormant through worktree activation',
    (state) => {
      const record = makeRecoveryRecord({ state })
      seedStore([record])

      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

      const after = useAppStore.getState()
      expect(after.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      expect(after.tabsByWorktree['wt-1']).toEqual([])
    }
  )

  it('leaves recovery rows dormant through a mobile background wake', () => {
    const working = makeRecoveryRecord()
    const done = makeRecoveryRecord({ paneKey: 'tab-2:leaf-2', tabId: 'tab-2', state: 'done' })
    seedStore([working, done])
    const mounts: unknown[] = []
    const onMount = (event: Event): void => {
      mounts.push(event)
    }
    window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')
    window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)

    const after = useAppStore.getState()
    expect(mounts).toEqual([])
    expect(after.tabsByWorktree['wt-1']).toEqual([])
    expect(after.sleepingAgentSessionsByPaneKey).toEqual({
      [working.paneKey]: working,
      [done.paneKey]: done
    })
  })
})
