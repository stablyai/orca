import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StructuredSessionOpenResult,
  StructuredSessionOpenSource
} from '../../../../../shared/agent-session/view/open-structured-agent-session'

const mocks = vi.hoisted(() => ({ interaction: vi.fn() }))
vi.mock('./open-existing-structured-session', () => ({
  openDesktopStructuredSessionInteraction: mocks.interaction,
  revealStructuredSession: vi.fn()
}))

import { openDesktopStructuredSession } from './activate-ai-vault-structured-session'

const notFound: StructuredSessionOpenResult = {
  kind: 'failed',
  failure: { reason: 'unknown', beforeEffects: true }
}

function feedback() {
  return { unavailable: vi.fn(), gone: vi.fn(), hostCannotOpen: vi.fn(), notLocated: vi.fn() }
}

/** Opens `source` and has its host answer with `result`. */
async function answer(source: StructuredSessionOpenSource, result: StructuredSessionOpenResult) {
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
  await openDesktopStructuredSession(source, undefined, undefined, undefined, shown)
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
