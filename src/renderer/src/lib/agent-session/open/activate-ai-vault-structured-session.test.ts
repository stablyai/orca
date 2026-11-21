import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StructuredSessionOpenResult,
  StructuredSessionOpenSource
} from '../../../../../shared/agent-session/view/open-structured-agent-session'

const mocks = vi.hoisted(() => ({ interaction: vi.fn(), activate: vi.fn(), owner: vi.fn() }))
vi.mock('./open-existing-structured-session', () => ({
  openDesktopStructuredSessionInteraction: mocks.interaction,
  revealStructuredSession: vi.fn()
}))
vi.mock('../../workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activate
}))
vi.mock('../../workspace/activation/wsl-moved-chat-activation', () => ({
  activateWslMovedWorkspace: () => false
}))
vi.mock('../../workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.owner
}))

import { openDesktopStructuredSession } from './activate-ai-vault-structured-session'
import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const notFound: StructuredSessionOpenResult = {
  kind: 'failed',
  failure: { reason: 'unknown', beforeEffects: true }
}

function feedback() {
  return { unavailable: vi.fn(), gone: vi.fn(), hostCannotOpen: vi.fn(), notLocated: vi.fn() }
}

/** Opens `source` and has its host answer with `result`. */
async function answer(
  source: StructuredSessionOpenSource,
  result: StructuredSessionOpenResult,
  host?: RuntimeClientTarget
) {
  const shown = feedback()
  mocks.interaction.mockImplementation(
    async (
      _source: unknown,
      options: { present: (result: StructuredSessionOpenResult) => void }
    ) => {
      options.present(result)
      return result
    }
  )
  await openDesktopStructuredSession(source, host, undefined, undefined, shown)
  return shown
}

beforeEach(() => vi.clearAllMocks())

describe('an open its host answers with nothing found', () => {
  it('says a worker could not be located, not that a chat is pending', async () => {
    const shown = await answer(
      {
        kind: 'sender',
        party: { address: 'dispatch:ctx_remote', terminalHandle: null, orcaSessionId: null },
        messageIds: [],
        displayName: 'ENG-14275 worker'
      },
      notFound
    )
    expect(shown.notLocated).toHaveBeenCalledWith('ENG-14275 worker')
    expect(shown.unavailable).not.toHaveBeenCalled()
  })

  it("keeps the retry notice for a chat's own reopen", async () => {
    const shown = await answer(
      { kind: 'history', structuredSession: { sessionId: 's1', workspaceId: 'w1' } },
      notFound
    )
    expect(shown.unavailable).toHaveBeenCalled()
    expect(shown.notLocated).not.toHaveBeenCalled()
  })
})

describe('a chat its paired host opened', () => {
  it("selects that host's workspace, not a same-id checkout on this machine", async () => {
    mocks.owner.mockReturnValue('studio')
    await answer(
      { kind: 'history', structuredSession: { sessionId: 's1', workspaceId: 'repo::/w' } },
      {
        kind: 'opened',
        target: { sessionId: 's1', worktreeId: 'repo::/w' },
        tab: { id: 'tab-1', sessionId: 's1' }
      }
    )

    expect(mocks.activate).toHaveBeenCalledWith('repo::/w', { executionHostId: 'runtime:studio' })
  })

  it('leaves an already-shown workspace alone when only that host has it', async () => {
    mocks.owner.mockReturnValue('studio')
    useAppStore.setState({
      activeWorktreeId: 'repo::/w',
      activeView: 'terminal',
      activeWorkspaceExecutionHostId: null
    })
    await answer(
      { kind: 'history', structuredSession: { sessionId: 's1', workspaceId: 'repo::/w' } },
      {
        kind: 'opened',
        target: { sessionId: 's1', worktreeId: 'repo::/w' },
        tab: { id: 'tab-1', sessionId: 's1' }
      }
    )

    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('moves off a selected paired twin when the chat lives on this machine', async () => {
    useAppStore.setState({
      activeWorktreeId: 'repo::/w',
      activeView: 'terminal',
      activeWorkspaceExecutionHostId: 'runtime:studio'
    })
    await answer(
      { kind: 'history', structuredSession: { sessionId: 's1', workspaceId: 'repo::/w' } },
      {
        kind: 'opened',
        target: { sessionId: 's1', worktreeId: 'repo::/w' },
        tab: { id: 'tab-1', sessionId: 's1' }
      },
      { kind: 'local' }
    )

    expect(mocks.activate).toHaveBeenCalledWith('repo::/w', { executionHostId: 'local' })
  })
})
