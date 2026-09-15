import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

function seed(
  claim: 'status' | 'startup' | 'automatic',
  options: { foreignHost?: boolean; foreignAccount?: boolean; folder?: boolean } = {}
) {
  const worktreeId = 'repo::/one'
  const otherId = options.folder ? 'folder:two' : 'repo::/two'
  const record: SleepingAgentSessionRecord = {
    paneKey: 'old:leaf',
    tabId: 'old',
    worktreeId,
    agent: 'claude',
    providerSession: {
      key: 'session_id',
      id: 'session',
      transcriptPath: '/account-a/session.jsonl'
    },
    prompt: '',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1
  }
  const providerSession = {
    ...record.providerSession,
    ...(options.foreignAccount ? { transcriptPath: '/account-b/session.jsonl' } : {})
  }
  const otherHost = options.foreignHost ? 'ssh:other' : 'local'
  useAppStore.setState({
    repos: [{ id: 'repo', executionHostId: 'local' }],
    worktreesByRepo: {
      repo: [
        { id: worktreeId, repoId: 'repo', hostId: 'local', path: '/one' },
        { id: otherId, repoId: 'repo', hostId: otherHost, path: '/two' }
      ]
    },
    folderWorkspaces: options.folder
      ? [{ id: 'two', projectGroupId: 'group', executionHostId: otherHost }]
      : [],
    projectGroups: options.folder ? [{ id: 'group', executionHostId: otherHost }] : [],
    tabsByWorktree: { [otherId]: [{ id: 'owner', worktreeId: otherId, ptyId: 'live' }] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
    agentStatusByPaneKey:
      claim === 'status'
        ? {
            'owner:leaf': {
              paneKey: 'owner:leaf',
              tabId: 'owner',
              worktreeId: otherId,
              agentType: 'claude',
              providerSession,
              state: 'working'
            }
          }
        : {},
    pendingStartupByTabId:
      claim === 'startup'
        ? { owner: { launchAgent: 'claude', resumeProviderSession: providerSession } }
        : {},
    automaticAgentResumeClaimsByTabId:
      claim === 'automatic'
        ? { owner: { worktreeId: otherId, launchAgent: 'claude', providerSession } }
        : {}
  } as never)
  return { record, worktreeId }
}

describe('sleeping resume claims across workspaces', () => {
  it.each(['status', 'startup', 'automatic'] as const)(
    'honors a same-host same-transcript %s claim',
    (claim) => {
      const { record, worktreeId } = seed(claim)
      expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
      expect(useAppStore.getState().tabsByWorktree[worktreeId]).toBeUndefined()
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    }
  )
  it.each([{ foreignHost: true }, { foreignAccount: true }])(
    'does not claim another host or account: %j',
    (options) => {
      const { worktreeId } = seed('status', options)
      expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
    }
  )
  it('coalesces consecutive worktree sweeps before a queued resume spawns', () => {
    const { record, worktreeId } = seed('status')
    const second = { ...record, paneKey: 'second:leaf', tabId: 'second', worktreeId: 'repo::/two' }
    useAppStore.setState({
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record, [second.paneKey]: second }
    })
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
    expect(resumeSleepingAgentSessionsForWorktree(second.worktreeId)).toBe(0)
    expect(Object.values(useAppStore.getState().tabsByWorktree).flat()).toHaveLength(1)
  })

  it('honors a folder workspace owner', () => {
    const { worktreeId } = seed('status', { folder: true })
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
  })
  it('does not infer an account match from a legacy ID-only record', () => {
    const { record, worktreeId } = seed('status')
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [record.paneKey]: { ...record, providerSession: { key: 'session_id', id: 'session' } }
      }
    })
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
  })
})
