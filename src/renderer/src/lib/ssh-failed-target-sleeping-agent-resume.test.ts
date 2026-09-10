/**
 * The resume half of the terminal-state floor.
 *
 * `workspace-terminal-host-authority.ts` says an SSH target whose sync terminated in
 * `offline`/`error` without ever hydrating answers `none`, so this client may act. The seeding
 * consumer is covered end to end (worktree-agent-activation-seam.test.ts); the sleeping-agent
 * consumer (resume-sleeping-agent-session.ts) was only covered at the predicate. Without this,
 * a failed target's agents stay unresumable for the rest of the app session and nothing fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { resolveWorkspaceTerminalHostAuthority } from './workspace-terminal-host-authority'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const initialAppStoreState = useAppStore.getState()
const TARGET_ID = 'ssh-target-1'
const WORKTREE_ID = 'repoSsh::/srv/proj/feature'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function seedFailedSshTarget(phase?: 'offline' | 'error' | 'pulling'): void {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const record: SleepingAgentSessionRecord = {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'pi',
    providerSession: { key: 'session_id', id: 'pi-session-1', transcriptPath: '/tmp/pi-1.jsonl' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
  useAppStore.setState({
    repos: [
      {
        id: 'repoSsh',
        path: '/srv/proj',
        displayName: 'repoSsh',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      }
    ] as never,
    worktreesByRepo: {
      repoSsh: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repoSsh',
          path: '/srv/proj/feature',
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    },
    remoteWorkspaceHydratedTargetIds: new Set<string>(),
    remoteWorkspaceSyncStatusByTargetId:
      phase === undefined ? {} : { [TARGET_ID]: { phase, direction: 'pull' as const } },
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  })
}

describe('sleeping-agent resume on a failed SSH target', () => {
  it.each(['offline', 'error'] as const)(
    'resumes a sleeping agent once a sync terminates in %s without ever hydrating',
    (phase) => {
      seedFailedSshTarget(phase)

      expect(resolveWorkspaceTerminalHostAuthority(useAppStore.getState(), WORKTREE_ID)).toBe(
        'none'
      )
      // The gate this exists for: a target that failed must not stay unresumable for the session.
      expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    }
  )

  it('still declines to resume while the host has not answered', () => {
    // Control: an in-flight sync is `unverifiable`, and resuming there forks a session the host
    // may still be running. The floor must not widen into "resume whenever we are unsure".
    seedFailedSshTarget('pulling')

    expect(resolveWorkspaceTerminalHostAuthority(useAppStore.getState(), WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeDefined()
  })

  it('still declines to resume when no sync status exists at all', () => {
    seedFailedSshTarget(undefined)

    expect(resolveWorkspaceTerminalHostAuthority(useAppStore.getState(), WORKTREE_ID)).toBe(
      'unverifiable'
    )
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
  })
})
