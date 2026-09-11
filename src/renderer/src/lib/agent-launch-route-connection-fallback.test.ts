import { describe, expect, it } from 'vitest'
import { buildAgentLaunchRouteInput, type AgentLaunchRouteStore } from './agent-launch-route-input'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { planAgentSessionLaunch } from './agent-session-launch-plan'

// Deliberately un-mocked: the defect this pins lives in the owner resolution itself, so a suite
// that stages `getConnectionIdFromState` cannot catch it. Grok is the agent the answer routes on —
// only agents whose hook discloses no transcript path read the local-readability input at all.
const NATIVE_CHAT_SETTINGS = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
const WORKTREE_ID = 'repo-1::/repo/wt-1'
const WORKSPACE = { kind: 'git-worktree', worktreeId: WORKTREE_ID, repoId: 'repo-1' } as const

/** Rival repos publishing the same worktree id on different hosts: the documented case where owner
 *  resolution refuses to name a connection rather than authorize a local read of a remote path. */
function storeWithAmbiguousWorktreeRows(
  repoConnectionId: string | null
): AgentLaunchRouteStore & { repos: unknown[] } {
  return {
    settings: NATIVE_CHAT_SETTINGS,
    repos: [{ id: 'repo-1', path: '/repo', connectionId: repoConnectionId }],
    worktreesByRepo: {
      'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: null }],
      'repo-2': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: 'ssh:other-box' }]
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
    expect(planAgentSessionLaunch(store, { agent: 'grok', workspace: WORKSPACE }).route).toBe(
      'legacy-native-chat'
    )
  })

  it('keeps a remote repo off native chat through the same fallback', () => {
    const store = storeWithAmbiguousWorktreeRows('build-box')

    expect(planAgentSessionLaunch(store, { agent: 'grok', workspace: WORKSPACE }).route).toBe(
      'terminal-tui'
    )
  })

  it('has no repo to fall back to when the workspace names none', () => {
    const store = storeWithAmbiguousWorktreeRows(null)

    expect(
      planAgentSessionLaunch(store, {
        agent: 'grok',
        workspace: { kind: 'git-worktree', worktreeId: WORKTREE_ID }
      }).route
    ).toBe('terminal-tui')
  })
})
