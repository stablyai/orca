import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it } from 'vitest'
import { buildAgentLaunchRouteInput, type AgentLaunchRouteStore } from './agent-launch-route-input'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { planAgentSessionLaunch } from './agent-session-launch-plan'

// Use real owner resolution to catch ambiguous-host fallback; Grok’s local transcript policy makes this answer affect routing.
const NATIVE_CHAT_SETTINGS = { nativeChatProviders: EVERY_AGENT_CHAT }
const WORKTREE_ID = 'repo-1::/repo/wt-1'
const WORKSPACE = { kind: 'git-worktree', worktreeId: WORKTREE_ID, repoId: 'repo-1' } as const

/** Same-ID workspaces on rival hosts must leave ownership unresolved rather than authorize reading a remote path locally. */
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
    // An undefined owner answer does not prove the transcript unreadable.
    expect(
      getConnectionIdFromState(storeWithAmbiguousWorktreeRows(null), WORKTREE_ID)
    ).toBeUndefined()
  })

  it('uses the local repo for readability while unresolved ownership keeps the terminal route', () => {
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
      buildAgentLaunchRouteInput(store, { agent: 'grok', workspace: WORKSPACE })
        .nativeChatTranscriptIsLocalReadable
    ).toBe(false)

    expect(
      planAgentSessionLaunch(store, { requestId: 'request-2', agent: 'grok', workspace: WORKSPACE })
        .route
    ).toBe('terminal-tui')
  })

  it('has no repo to fall back to when the workspace names none', () => {
    const store = storeWithAmbiguousWorktreeRows(null)

    expect(
      buildAgentLaunchRouteInput(store, {
        agent: 'grok',
        workspace: { kind: 'git-worktree', worktreeId: WORKTREE_ID }
      }).nativeChatTranscriptIsLocalReadable
    ).toBe(false)

    expect(
      planAgentSessionLaunch(store, {
        requestId: 'request-3',
        agent: 'grok',
        workspace: { kind: 'git-worktree', worktreeId: WORKTREE_ID }
      }).route
    ).toBe('terminal-tui')
  })
})
