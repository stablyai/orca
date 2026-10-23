import { describe, expect, it } from 'vitest'
import { buildAgentLaunchRouteInput, type AgentLaunchRouteStore } from './agent-launch-route-input'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { planAgentSessionLaunch } from './agent-session-launch-plan'

// Deliberately un-mocked: the defect this pins lives in the owner resolution itself, so a suite
// that stages `getConnectionIdFromState` cannot catch it. Grok is the agent the answer routes on —
// only agents whose hook discloses no transcript path read the local-readability input at all.
const NATIVE_CHAT_SETTINGS = { experimentalNativeChat: true }
const WORKTREE_ID = 'repo-1::/repo/wt-1'
const WORKSPACE = { kind: 'git-worktree', worktreeId: WORKTREE_ID, repoId: 'repo-1' } as const

/** Rival repos publishing the same worktree id on different hosts: the documented case where owner
 *  resolution refuses to name a connection rather than authorize a local read of a remote path. */
function storeWithAmbiguousWorktreeRows(
  repoConnectionId: string | null,
  otherHostId = 'ssh:other-box',
  settings: Record<string, unknown> = NATIVE_CHAT_SETTINGS
): AgentLaunchRouteStore & { repos: unknown[] } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the slices owner resolution reads are staged.
  return {
    settings,
    repos: [{ id: 'repo-1', path: '/repo', connectionId: repoConnectionId }],
    worktreesByRepo: {
      'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: null }],
      'repo-2': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: otherHostId }]
    }
  } as unknown as AgentLaunchRouteStore & { repos: unknown[] }
}

describe('launch route transcript readability', () => {
  it('cannot name the connection from the worktree when its rows disagree', () => {
    // The premise of the fallback: this is what returns `undefined`, and `undefined` is not
    // evidence that the transcript is unreadable.
    expect(
      getConnectionIdFromState(storeWithAmbiguousWorktreeRows(null), WORKTREE_ID)
    ).toBeUndefined()
  })

  it('falls back to the local repo rather than downgrading native chat to a terminal', () => {
    const store = storeWithAmbiguousWorktreeRows(null)

    expect(
      buildAgentLaunchRouteInput(store, { agent: 'grok', workspace: WORKSPACE })
        .nativeChatTranscriptIsLocalReadable
    ).toBe(true)
    expect(
      planAgentSessionLaunch(store, { requestId: 'request-1', agent: 'grok', workspace: WORKSPACE })
        .route
    ).toBe('terminal-tui')
  })

  it('keeps a remote repo off native chat through the same fallback', () => {
    const store = storeWithAmbiguousWorktreeRows('build-box')

    expect(
      planAgentSessionLaunch(store, { requestId: 'request-2', agent: 'grok', workspace: WORKSPACE })
        .route
    ).toBe('terminal-tui')
  })

  it('has no repo to fall back to when the workspace names none', () => {
    const store = storeWithAmbiguousWorktreeRows(null)

    expect(
      planAgentSessionLaunch(store, {
        requestId: 'request-3',
        agent: 'grok',
        workspace: { kind: 'git-worktree', worktreeId: WORKTREE_ID }
      }).route
    ).toBe('terminal-tui')
  })
})

it.each(['duplicate', 'sentinel', 'focused', 'owned'] as const)(
  'admits missing-status native chat only with explicit ownership: %s',
  (kind) => {
    const store = storeWithAmbiguousWorktreeRows(null, 'runtime:server-1', {
      ...NATIVE_CHAT_SETTINGS,
      activeRuntimeEnvironmentId: 'server-1'
    })
    if (kind !== 'duplicate') {
      delete store.worktreesByRepo![kind === 'focused' ? 'repo-2' : 'repo-1']
    }
    if (kind === 'sentinel') {
      store.activeWorktreeId = WORKTREE_ID
      store.activeWorkspaceExecutionHostId = 'runtime:unresolved-owner'
    }
    const plan = planAgentSessionLaunch(store, {
      requestId: 'owner-admission',
      agent: 'claude',
      workspace: WORKSPACE
    })
    expect(plan.route).toBe(kind === 'owned' ? 'structured-native-chat' : 'terminal-tui')
    expect(plan.executionHostId).toBe(kind === 'owned' ? 'runtime:server-1' : undefined)
  }
)
