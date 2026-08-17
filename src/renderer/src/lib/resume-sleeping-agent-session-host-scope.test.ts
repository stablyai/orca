import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

function makeRecord(
  paneKey: string,
  worktreeId: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    ...overrides
  }
}

describe('sleeping agent execution host scope', () => {
  it('launches and clears only the selected host when workspace ids collide', () => {
    const local = makeRecord('local-pane', 'same-worktree', { executionHostId: 'local' })
    const ssh = makeRecord('ssh-pane', 'same-worktree', {
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    })
    const runtime = makeRecord('runtime-pane', 'same-worktree', {
      executionHostId: 'runtime:env-1',
      state: 'done'
    })
    useAppStore.setState({
      tabsByWorktree: { 'same-worktree': [] },
      sleepingAgentSessionsByPaneKey: {
        [local.paneKey]: local,
        [ssh.paneKey]: ssh,
        [runtime.paneKey]: runtime
      }
    } as never)

    expect(
      resumeSleepingAgentSessionsForWorktree('same-worktree', { executionHostId: 'local' })
    ).toBe(1)

    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[local.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[ssh.paneKey]).toBe(ssh)
    expect(state.sleepingAgentSessionsByPaneKey[runtime.paneKey]).toBe(runtime)
  })

  it('keeps same-key folder records from another host untouched', () => {
    const workspaceId = folderWorkspaceKey('same-folder')
    const local = makeRecord('local-folder-pane', workspaceId, { executionHostId: 'local' })
    const runtime = makeRecord('runtime-folder-pane', workspaceId, {
      executionHostId: 'runtime:env-1'
    })
    useAppStore.setState({
      tabsByWorktree: { [workspaceId]: [] },
      sleepingAgentSessionsByPaneKey: {
        [local.paneKey]: local,
        [runtime.paneKey]: runtime
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(workspaceId, { executionHostId: 'local' })).toBe(
      1
    )
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[runtime.paneKey]).toBe(runtime)
  })

  it('matches legacy SSH provenance but preserves ambiguous legacy records', () => {
    const ssh = makeRecord('ssh-pane', 'same-worktree', { connectionId: 'ssh target' })
    const ambiguous = makeRecord('legacy-pane', 'same-worktree')
    useAppStore.setState({
      tabsByWorktree: { 'same-worktree': [] },
      sleepingAgentSessionsByPaneKey: {
        [ssh.paneKey]: ssh,
        [ambiguous.paneKey]: ambiguous
      }
    } as never)

    expect(
      resumeSleepingAgentSessionsForWorktree('same-worktree', {
        executionHostId: 'ssh:ssh%20target'
      })
    ).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[ambiguous.paneKey]).toBe(ambiguous)
  })

  it('ignores foreign-host legacy claims when checking preserved pane ownership', () => {
    const local = makeRecord('tab-1:0', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'local'
    })
    const runtime = makeRecord('tab-1:1', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'runtime:env-1'
    })
    useAppStore.setState({
      activeWorktreeId: 'same-worktree',
      tabsByWorktree: {
        'same-worktree': [
          {
            id: 'tab-1',
            ptyId: 'wake-hint',
            worktreeId: 'same-worktree',
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [local.paneKey]: local,
        [runtime.paneKey]: runtime
      }
    } as never)

    expect(
      resumeSleepingAgentSessionsForWorktree('same-worktree', { executionHostId: 'local' })
    ).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[local.paneKey]).toBe(local)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[runtime.paneKey]).toBe(runtime)
  })

  it('includes passive same-host records in legacy pane ownership ambiguity', () => {
    const active = makeRecord('tab-1:0', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'local'
    })
    const passive = makeRecord('tab-1:1', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'local',
      state: 'done',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'passive-session' }
    })
    useAppStore.setState({
      activeWorktreeId: 'same-worktree',
      tabsByWorktree: {
        'same-worktree': [
          {
            id: 'tab-1',
            ptyId: 'wake-hint',
            worktreeId: 'same-worktree',
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [active.paneKey]: active,
        [passive.paneKey]: passive
      }
    } as never)

    expect(
      resumeSleepingAgentSessionsForWorktree('same-worktree', { executionHostId: 'local' })
    ).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[active.paneKey]).toBeUndefined()
  })

  it('excludes invalid same-host records from legacy pane ownership ambiguity', () => {
    const active = makeRecord('tab-1:0', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'local'
    })
    const invalid = makeRecord('tab-1:1', 'same-worktree', {
      tabId: 'tab-1',
      executionHostId: 'local',
      state: 'done',
      origin: undefined,
      providerSession: { key: 'session_id', id: 'invalid-session' },
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      activeWorktreeId: 'same-worktree',
      tabsByWorktree: {
        'same-worktree': [
          {
            id: 'tab-1',
            ptyId: 'wake-hint',
            worktreeId: 'same-worktree',
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [active.paneKey]: active,
        [invalid.paneKey]: invalid
      }
    } as never)

    expect(
      resumeSleepingAgentSessionsForWorktree('same-worktree', { executionHostId: 'local' })
    ).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[active.paneKey]).toBe(active)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[invalid.paneKey]).toBeUndefined()
  })
})
