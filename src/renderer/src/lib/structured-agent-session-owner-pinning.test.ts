// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: () => () => undefined
  }
}))

import { createStructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import {
  adoptAgentSessionLaunchVerdict,
  planAgentSessionLaunch,
  type AgentSessionLaunchVerdict
} from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import {
  buildQuickCreationRequest,
  type QuickCreationRequestInput
} from '@/hooks/composer-state/quick-creation-request'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { structuredAgentSessionOwnerMatchesPairing } from '@/runtime/structured-agent-session-owner'

const WORKTREE_ID = 'repo-1::/repo/wt-1'

function ownWorktreeWith(executionHostId: string): void {
  mocks.state = {
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: executionHostId,
    unifiedTabsByWorktree: {},
    groupsByWorktree: {}
  }
}

function pairEnvironment(environmentId: string, pairingRevision: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1, pairingRevision }])
}

/** Only the fields the request builder reads; the rest never reaches the owner it carries. */
function quickCreationInput(
  overrides: Partial<QuickCreationRequestInput>
): QuickCreationRequestInput {
  return {
    repoId: 'repo-1',
    workspaceName: 'wt-1',
    agent: 'codex',
    linkedWorkItem: null,
    ...overrides
  } as QuickCreationRequestInput
}

describe('structured session owner pinning', () => {
  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    ownWorktreeWith('local')
  })

  it('pins the environment and its pairing revision when the intent is made', () => {
    pairEnvironment('env-1', 7)
    ownWorktreeWith('runtime:env-1')

    const intent = createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex')
    // Re-pair immediately after, with no await in between: a capture that read the revision lazily
    // would answer 8 here and silently retarget the retry.
    pairEnvironment('env-1', 8)

    expect(intent.owner).toEqual({
      kind: 'environment',
      environmentId: 'env-1',
      pairingRevision: 7
    })
  })

  it('stops matching once the environment is re-paired between capture and use', () => {
    pairEnvironment('env-1', 7)
    ownWorktreeWith('runtime:env-1')

    const { owner } = createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex')
    expect(structuredAgentSessionOwnerMatchesPairing(owner)).toBe(true)

    pairEnvironment('env-1', 8)
    expect(structuredAgentSessionOwnerMatchesPairing(owner)).toBe(false)
  })

  it('re-enters quick create with the owner the plan pinned, not the workspace made after it', () => {
    pairEnvironment('env-1', 7)
    const store = {
      settings: { experimentalNativeChat: true, openAgentTabsInChatByDefault: true },
      repos: [{ id: 'repo-1', path: '/repo' }]
    } as unknown as AgentLaunchRouteStore
    const plan = planAgentSessionLaunch(store, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1', executionHostId: 'runtime:env-1' }
    })

    const request = buildQuickCreationRequest(
      quickCreationInput({ agentLaunchRoute: plan.route, agentSessionOwner: plan.owner })
    )

    // The worktree exists by re-entry time and is owned by a different host than planning saw.
    ownWorktreeWith('runtime:env-2')
    const reentered = adoptAgentSessionLaunchVerdict({
      route: request.agentLaunchRoute as AgentSessionLaunchVerdict['route'],
      agent: 'codex',
      ...(request.agentSessionOwner ? { owner: request.agentSessionOwner } : {})
    })

    expect(reentered.owner).toEqual({
      kind: 'environment',
      environmentId: 'env-1',
      pairingRevision: 7
    })
    // What re-deriving from the workspace would have answered instead.
    expect(createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex').owner).toEqual({
      kind: 'environment',
      environmentId: 'env-2'
    })
  })
})
