import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  agentSessionProviderHandlesEqual,
  appendAgentSessionProviderHandleLink,
  findAgentSessionProviderHandleLink,
  isAgentSessionProviderHandle,
  isAgentSessionHandleProvider,
  isAgentSessionProviderHandleChain,
  MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'

const CLAUDE: AgentSessionProviderHandle = {
  provider: 'claude',
  sessionId: 'sess-1',
  leafUuid: 'leaf-1'
}

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
  it('rejects unknown persisted provider names instead of defaulting to Codex', () => {
    expect(isAgentSessionHandleProvider('codex')).toBe(true)
    expect(isAgentSessionHandleProvider('claude')).toBe(true)
    expect(isAgentSessionHandleProvider('gemini')).toBe(false)
    expect(isAgentSessionHandleProvider(undefined)).toBe(false)
  })

  it('keys a Claude handle by session id AND leaf, so two branches are two handles', () => {
    // Concurrent resumes branch one transcript silently; the session id alone cannot name a writer.
    const branchA = agentSessionProviderHandleKey(CLAUDE)
    const branchB = agentSessionProviderHandleKey({ ...CLAUDE, leafUuid: 'leaf-2' })
    expect(branchA).not.toEqual(branchB)
    expect(agentSessionProviderHandleRoot(CLAUDE)).toEqual(
      agentSessionProviderHandleRoot({ ...CLAUDE, leafUuid: 'leaf-2' })
    )
  })

  it('keys a Codex handle by thread id alone', () => {
    const codex: AgentSessionProviderHandle = { provider: 'codex', threadId: 'thread-1' }
    expect(agentSessionProviderHandleKey(codex)).toBe('codex:"thread-1"')
    expect(agentSessionProviderHandleRoot(codex)).toBe('codex:"thread-1"')
    expect(
      agentSessionProviderHandlesEqual(codex, { provider: 'codex', threadId: 'thread-2' })
    ).toBe(false)
  })

  it('distinguishes a null leaf from an empty-string leaf and rejects malformed handles', () => {
    expect(isAgentSessionProviderHandle({ ...CLAUDE, leafUuid: null })).toBe(true)
    expect(isAgentSessionProviderHandle({ ...CLAUDE, leafUuid: '' })).toBe(false)
    expect(isAgentSessionProviderHandle({ provider: 'claude', sessionId: '' })).toBe(false)
    expect(isAgentSessionProviderHandle({ provider: 'gemini', sessionId: 'x' })).toBe(false)
    expect(isAgentSessionProviderHandle({ ...CLAUDE, sessionId: ' sess-1 ' })).toBe(false)
  })

  it('uses collision-free keys when Claude ids contain delimiters', () => {
    const left: AgentSessionProviderHandle = {
      provider: 'claude',
      sessionId: 'a#b',
      leafUuid: 'c'
    }
    const right: AgentSessionProviderHandle = {
      provider: 'claude',
      sessionId: 'a',
      leafUuid: 'b#c'
    }
    expect(agentSessionProviderHandleKey(left)).not.toBe(agentSessionProviderHandleKey(right))
    expect(agentSessionProviderHandlesEqual(left, right)).toBe(false)
  })
})

describe('chain append', () => {
  it('starts only from a created or adopted link', () => {
    expect(appendAgentSessionProviderHandleLink([], link())).toEqual([link()])
    expect(appendAgentSessionProviderHandleLink([], link({ origin: 'adopted' }))).toHaveLength(1)
    expect(() => appendAgentSessionProviderHandleLink([], link({ origin: 'resumed' }))).toThrow(
      'agent_session_provider_handle_invalid'
    )
  })

  it('refuses to record a fork as a resume', () => {
    // --fork-session keeps the original item ids; calling it a resume would claim continuity the
    // provider never gave.
    const chain = [link()]
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        link({
          linkId: 'link-2',
          origin: 'resumed',
          handle: { provider: 'claude', sessionId: 'sess-2', leafUuid: 'leaf-9' },
          mintedAtFence: 2
        })
      )
    ).toThrow('agent_session_provider_handle_forked')
  })

  it('records a fork only with a new root and the seed it came from', () => {
    const chain = [link()]
    const forked = link({
      linkId: 'link-2',
      origin: 'forked',
      handle: { provider: 'claude', sessionId: 'sess-2', leafUuid: 'leaf-9' },
      mintedAtFence: 2,
      forkedFromKey: agentSessionProviderHandleKey(CLAUDE)
    })
    expect(appendAgentSessionProviderHandleLink(chain, forked)).toHaveLength(2)
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, { ...forked, forkedFromKey: 'claude:other' })
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, {
        ...forked,
        handle: CLAUDE,
        forkedFromKey: agentSessionProviderHandleKey(CLAUDE)
      })
    ).toThrow('agent_session_provider_handle_invalid')
  })

  it('rejects a link minted under an older fence', () => {
    const chain = [link({ mintedAtFence: 5 })]
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        link({
          linkId: 'link-2',
          origin: 'resumed',
          handle: { ...CLAUDE, leafUuid: 'leaf-2' },
          mintedAtFence: 4
        })
      )
    ).toThrow('agent_session_provider_handle_stale_fence')
  })

  it('rejects a provider change mid-chain', () => {
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [link()],
        link({
          linkId: 'link-2',
          origin: 'resumed',
          handle: { provider: 'codex', threadId: 'thread-1' },
          mintedAtFence: 2
        })
      )
    ).toThrow('agent_session_provider_handle_provider_mismatch')
  })

  it('treats re-proving the same handle at the same fence as a retry, not a new link', () => {
    const chain = [link({ mintedAtFence: 3 })]
    const retried = appendAgentSessionProviderHandleLink(
      chain,
      link({ linkId: 'link-2', origin: 'resumed', mintedAtFence: 3 })
    )
    expect(retried).toHaveLength(1)
    expect(retried[0]?.linkId).toBe('link-1')
    // A later fence on the same handle is a genuine re-acquisition and does append.
    expect(
      appendAgentSessionProviderHandleLink(
        chain,
        link({ linkId: 'link-2', origin: 'resumed', mintedAtFence: 4 })
      )
    ).toHaveLength(2)
  })

  it('rejects reuse of a stable link id for a different proof', () => {
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [link()],
        link({
          origin: 'resumed',
          handle: { ...CLAUDE, leafUuid: 'leaf-2' },
          mintedAtFence: 2
        })
      )
    ).toThrow('agent_session_provider_handle_invalid')
  })

  it('refuses to grow past the cap rather than dropping fork provenance', () => {
    const chain: AgentSessionProviderHandleLink[] = [link()]
    for (let index = 1; index < MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS; index += 1) {
      chain.push(
        link({
          linkId: `link-${index + 1}`,
          origin: 'resumed',
          handle: { ...CLAUDE, leafUuid: `leaf-${index + 1}` },
          mintedAtFence: index + 1
        })
      )
    }
    expect(chain).toHaveLength(MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS)
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        link({
          linkId: 'link-overflow',
          origin: 'resumed',
          handle: { ...CLAUDE, leafUuid: 'leaf-overflow' },
          mintedAtFence: 999
        })
      )
    ).toThrow('agent_session_provider_handle_chain_overflow')
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    expect(agentSessionProviderHandleChainHead(chain)?.linkId).toBe(
      `link-${MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS}`
    )
  })

  it('never mutates the chain it was given', () => {
    const chain = [link()]
    appendAgentSessionProviderHandleLink(
      chain,
      link({
        linkId: 'link-2',
        origin: 'resumed',
        handle: { ...CLAUDE, leafUuid: 'leaf-2' },
        mintedAtFence: 2
      })
    )
    expect(chain).toHaveLength(1)
  })
})

describe('chain lookup and validation', () => {
  it('finds a link by id and reports the head', () => {
    const chain = appendAgentSessionProviderHandleLink(
      [link()],
      link({
        linkId: 'link-2',
        origin: 'resumed',
        handle: { ...CLAUDE, leafUuid: 'leaf-2' },
        mintedAtFence: 2
      })
    )
    expect(findAgentSessionProviderHandleLink(chain, 'link-1')?.origin).toBe('created')
    expect(findAgentSessionProviderHandleLink(chain, 'missing')).toBeNull()
    expect(agentSessionProviderHandleChainHead(chain)?.linkId).toBe('link-2')
    expect(agentSessionProviderHandleChainHead([])).toBeNull()
  })

  it('rejects a persisted chain that is over the cap or holds a malformed link', () => {
    expect(isAgentSessionProviderHandleChain([{ ...link(), mintedAtFence: -1 }])).toBe(false)
    expect(isAgentSessionProviderHandleChain([{ ...link(), linkId: 'not a link id!' }])).toBe(false)
    expect(isAgentSessionProviderHandleChain([{ ...link(), forkedFromKey: 'claude:seed' }])).toBe(
      false
    )
    expect(
      isAgentSessionProviderHandleChain(
        Array.from({ length: MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS + 1 }, (_value, index) =>
          link({ linkId: `link-${index}` })
        )
      )
    ).toBe(false)
  })

  it('rejects persisted chains that bypass append invariants', () => {
    expect(
      isAgentSessionProviderHandleChain([
        link(),
        link({
          linkId: 'link-2',
          origin: 'created',
          mintedAtFence: 2
        })
      ])
    ).toBe(false)
    expect(
      isAgentSessionProviderHandleChain([
        link(),
        link({
          origin: 'resumed',
          handle: { ...CLAUDE, leafUuid: 'leaf-2' },
          mintedAtFence: 2
        })
      ])
    ).toBe(false)
    expect(
      isAgentSessionProviderHandleChain([
        link(),
        link({
          linkId: 'link-2',
          origin: 'resumed',
          handle: { provider: 'claude', sessionId: 'sess-2', leafUuid: 'leaf-2' },
          mintedAtFence: 2
        })
      ])
    ).toBe(false)
  })
})
