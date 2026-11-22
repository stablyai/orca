import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandlesEqual,
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle,
  codexProviderHandle
} from './agent-session-provider-handle-encoding'

const CLAUDE: AgentSessionProviderHandle = claudeProviderHandle('sess-1', 'leaf-1')

function link(overrides: Partial<AgentSessionProviderHandleLink> = {}) {
  return {
    linkId: 'link-1',
    handle: CLAUDE,
    origin: 'created',
    mintedAtFence: 1,
    observedAt: 1_000,
    ...overrides
  } as AgentSessionProviderHandleLink
}

describe('handle identity', () => {
  it('uses collision-free keys when Claude ids contain delimiters', () => {
    const left = claudeProviderHandle('a#b', 'c')
    const right = claudeProviderHandle('a', 'b#c')
    expect(agentSessionProviderHandlesEqual(left, right)).toBe(false)
  })
})

describe('superseding a creation the provider never saved', () => {
  const unsaved: AgentSessionProviderHandle = codexProviderHandle('thread-unsaved')
  const created = link({ linkId: 'codex-1-thread-unsaved', handle: unsaved })
  function replacement(overrides: Partial<AgentSessionProviderHandleLink> = {}) {
    return link({
      linkId: 'codex-3-thread-new',
      handle: codexProviderHandle('thread-new'),
      mintedAtFence: 3,
      supersedesKey: agentSessionProviderHandleKey(unsaved),
      ...overrides
    })
  }

  it('names exactly the head it replaces, on a new root, under a current fence', () => {
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [created],
        replacement({ supersedesKey: 'codex:"thread-other"' })
      )
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      appendAgentSessionProviderHandleLink([created], replacement({ handle: unsaved }))
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      appendAgentSessionProviderHandleLink([created], replacement({ linkId: created.linkId }))
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [{ ...created, mintedAtFence: 4 }],
        replacement({ mintedAtFence: 3 })
      )
    ).toThrow('agent_session_provider_handle_stale_fence')
  })
})

describe('replacing a conversation the provider could not restore', () => {
  const acp = (nativeId: string): AgentSessionProviderHandle => ({
    transport: 'acp',
    agent: 'grok',
    nativeId
  })
  const created = link({ handle: acp('s-1') })
  const resumed = link({
    linkId: 'link-2',
    origin: 'resumed',
    handle: acp('s-1'),
    mintedAtFence: 2
  })
  const lost = {
    key: agentSessionProviderHandleKey(acp('s-1')),
    reason: 'restore-failed',
    replacedAt: 3_000
  }
  function fresh(overrides: Partial<AgentSessionProviderHandleLink> = {}) {
    return link({
      linkId: 'link-3',
      handle: acp('s-2'),
      mintedAtFence: 3,
      observedAt: 3_000,
      replaces: lost,
      ...overrides
    })
  }

  it('stays lost when a fresh conversation the agent never saved is superseded in turn', () => {
    const chain = appendAgentSessionProviderHandleLink([created, resumed], fresh())
    const superseding = link({
      linkId: 'link-5',
      handle: acp('s-3'),
      mintedAtFence: 5,
      supersedesKey: agentSessionProviderHandleKey(acp('s-2'))
    })
    const superseded = appendAgentSessionProviderHandleLink(chain, superseding)
    expect(superseded).toEqual([created, resumed, { ...superseding, replaces: lost }])
    expect(isAgentSessionProviderHandleChain(superseded)).toBe(true)
    // Unused across many restarts, it still does not grow.
    const again = appendAgentSessionProviderHandleLink(superseded, {
      ...superseding,
      linkId: 'link-6',
      handle: acp('s-4'),
      mintedAtFence: 6,
      supersedesKey: agentSessionProviderHandleKey(acp('s-3'))
    })
    expect(again).toHaveLength(3)
    expect(again.at(-1)?.replaces).toEqual(lost)
    // A supersession cannot rewrite what was lost, nor land back on it.
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, {
        ...superseding,
        replaces: { ...lost, replacedAt: 9 }
      })
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, { ...superseding, handle: acp('s-1') })
    ).toThrow('agent_session_provider_handle_invalid')
  })
})
