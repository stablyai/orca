import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandlesEqual,
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain,
  MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS,
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
    expect(agentSessionProviderHandleKey(left)).not.toBe(agentSessionProviderHandleKey(right))
    expect(agentSessionProviderHandlesEqual(left, right)).toBe(false)
  })
})

describe('chain append', () => {
  it('records a fork only with a new root and the seed it came from', () => {
    const chain = [link()]
    const forked = link({
      linkId: 'link-2',
      origin: 'forked',
      handle: claudeProviderHandle('sess-2', 'leaf-9'),
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

  it('refuses to grow past the cap rather than dropping fork provenance', () => {
    const chain: AgentSessionProviderHandleLink[] = [link()]
    for (let index = 1; index < MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS; index += 1) {
      chain.push(
        link({
          linkId: `link-${index + 1}`,
          origin: 'resumed',
          handle: claudeProviderHandle('sess-1', `leaf-${index + 1}`),
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
          handle: claudeProviderHandle('sess-1', 'leaf-overflow'),
          mintedAtFence: 999
        })
      )
    ).toThrow('agent_session_provider_handle_chain_overflow')
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    expect(agentSessionProviderHandleChainHead(chain)?.linkId).toBe(
      `link-${MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS}`
    )
  })
})

describe('chain lookup and validation', () => {
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
          handle: claudeProviderHandle('sess-1', 'leaf-2'),
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
          handle: claudeProviderHandle('sess-2', 'leaf-2'),
          mintedAtFence: 2
        })
      ])
    ).toBe(false)
  })
})

describe('adopted chain heads', () => {
  // History resume seeds an adopted head before the provider's proof arrives.
  const adopted = (overrides: Partial<AgentSessionProviderHandleLink> = {}) =>
    link({
      linkId: 'claude-1-sess-1-empty',
      origin: 'adopted',
      handle: claudeProviderHandle('sess-1', null),
      ...overrides
    })

  it('appends a Claude resume that lands on the adopted root with a leaf', () => {
    // The adopted head names no leaf; the provider answers with one. Same root, so it is a resume.
    const resumed = link({
      linkId: 'claude-1-sess-1-leaf-1',
      origin: 'resumed',
      handle: CLAUDE,
      mintedAtFence: 1
    })
    const chain = appendAgentSessionProviderHandleLink([adopted()], resumed)

    expect(chain.map((entry) => entry.origin)).toEqual(['adopted', 'resumed'])
    expect(agentSessionProviderHandleChainHead(chain)).toBe(resumed)
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

  it('replaces the unsaved creation instead of standing beside it', () => {
    const chain = appendAgentSessionProviderHandleLink([created], replacement())
    expect(chain).toEqual([replacement()])
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    // An unused chat reopened across many restarts stays one link long.
    const again = appendAgentSessionProviderHandleLink(
      chain,
      replacement({
        linkId: 'codex-5-thread-newer',
        handle: codexProviderHandle('thread-newer'),
        mintedAtFence: 5,
        supersedesKey: agentSessionProviderHandleKey(codexProviderHandle('thread-new'))
      })
    )
    expect(again).toHaveLength(1)
    expect(again[0]?.handle).toEqual(codexProviderHandle('thread-newer'))
  })

  it('never supersedes a conversation a resume, fork or adoption proved', () => {
    const resumed = link({ linkId: 'codex-2-thread-unsaved', origin: 'resumed', handle: unsaved })
    expect(() => appendAgentSessionProviderHandleLink([created, resumed], replacement())).toThrow(
      'agent_session_provider_handle_invalid'
    )
    expect(() =>
      appendAgentSessionProviderHandleLink([{ ...created, origin: 'adopted' }], replacement())
    ).toThrow('agent_session_provider_handle_invalid')
  })

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

describe('a transport shared code has never heard of', () => {
  const acp = (nativeId: string, resumeCursor?: string): AgentSessionProviderHandle => ({
    transport: 'acp',
    agent: 'grok',
    nativeId,
    ...(resumeCursor === undefined ? {} : { resumeCursor })
  })

  it('chains resumes and forks by its native id alone', () => {
    const created = link({ handle: acp('s-1', '{"cwd":"/a"}') })
    const resumed = link({
      linkId: 'link-2',
      origin: 'resumed',
      handle: acp('s-1', '{"cwd":"/b"}'),
      mintedAtFence: 2
    })
    const chain = appendAgentSessionProviderHandleLink([created], resumed)
    expect(chain).toHaveLength(2)
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    expect(() =>
      appendAgentSessionProviderHandleLink(chain, {
        ...resumed,
        linkId: 'link-3',
        handle: acp('s-2')
      })
    ).toThrow('agent_session_provider_handle_forked')
    const forked = appendAgentSessionProviderHandleLink(chain, {
      ...resumed,
      linkId: 'link-3',
      origin: 'forked',
      handle: acp('s-2'),
      forkedFromKey: agentSessionProviderHandleKey(resumed.handle)
    })
    expect(forked.at(-1)?.handle.nativeId).toBe('s-2')
  })

  it('records a same-fence resume that only moved the resume cursor instead of eliding it', () => {
    const created = link({ handle: acp('s-1', 'a') })
    const moved = link({ linkId: 'link-2', origin: 'resumed', handle: acp('s-1', 'b') })
    expect(appendAgentSessionProviderHandleLink([created], moved)).toHaveLength(2)
    expect(
      appendAgentSessionProviderHandleLink([created], { ...moved, handle: acp('s-1', 'a') })
    ).toHaveLength(1)
  })

  it('never joins a chain of another transport or agent, even with the same id', () => {
    const chain = [link({ handle: codexProviderHandle('shared-id') })]
    for (const handle of [
      acp('shared-id'),
      { transport: 'codex-app-server', agent: 'grok', nativeId: 'shared-id' }
    ]) {
      expect(() =>
        appendAgentSessionProviderHandleLink(
          chain,
          link({ linkId: 'link-2', origin: 'resumed', handle, mintedAtFence: 2 })
        )
      ).toThrow()
    }
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

  it('follows a reopened conversation and keeps every link before it', () => {
    const chain = appendAgentSessionProviderHandleLink([created, resumed], fresh())
    expect(chain).toEqual([created, resumed, fresh()])
    expect(agentSessionProviderHandleChainHead(chain)?.handle.nativeId).toBe('s-2')
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    // The fresh conversation then resumes like any other.
    const reopened = appendAgentSessionProviderHandleLink(
      chain,
      link({ linkId: 'link-4', origin: 'resumed', handle: acp('s-2'), mintedAtFence: 4 })
    )
    expect(reopened).toHaveLength(4)
    expect(isAgentSessionProviderHandleChain(reopened)).toBe(true)
  })

  it('names exactly the head it took over from, on a new root', () => {
    for (const bad of [
      fresh({ replaces: { ...lost, key: agentSessionProviderHandleKey(acp('s-9')) } }),
      fresh({ handle: acp('s-1') }),
      fresh({ linkId: 'link-2' }),
      fresh({ replaces: undefined })
    ]) {
      expect(() => appendAgentSessionProviderHandleLink([created, resumed], bad)).toThrow(
        'agent_session_provider_handle_invalid'
      )
    }
    expect(() =>
      appendAgentSessionProviderHandleLink([created, resumed], fresh({ mintedAtFence: 1 }))
    ).toThrow('agent_session_provider_handle_stale_fence')
  })

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

  it('is refused in a Claude or Codex chain, whose rows older builds read', () => {
    for (const [first, lost, next] of [
      [CLAUDE, CLAUDE, claudeProviderHandle('sess-2', null)],
      [codexProviderHandle('t-1'), codexProviderHandle('t-1'), codexProviderHandle('t-2')]
    ] as const) {
      expect(() =>
        appendAgentSessionProviderHandleLink(
          [link({ handle: first })],
          fresh({
            handle: next,
            replaces: {
              key: agentSessionProviderHandleKey(lost),
              reason: 'restore-failed',
              replacedAt: 3_000
            }
          })
        )
      ).toThrow('agent_session_provider_handle_invalid')
    }
  })

  it('still supersedes only a creation the provider never saved', () => {
    const chain = appendAgentSessionProviderHandleLink([created, resumed], fresh())
    const proven = appendAgentSessionProviderHandleLink(
      chain,
      link({ linkId: 'link-4', origin: 'resumed', handle: acp('s-2'), mintedAtFence: 4 })
    )
    expect(() =>
      appendAgentSessionProviderHandleLink(
        proven,
        link({
          linkId: 'link-5',
          handle: acp('s-3'),
          mintedAtFence: 5,
          supersedesKey: agentSessionProviderHandleKey(acp('s-2'))
        })
      )
    ).toThrow('agent_session_provider_handle_invalid')
  })
})
