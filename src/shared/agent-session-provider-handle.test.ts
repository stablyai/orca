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
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import { claudeProviderHandle, codexProviderHandle } from './agent-session-provider-handle-encoding'

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
  it('rejects unknown persisted provider names instead of defaulting to Codex', () => {
    expect(isAgentSessionHandleProvider('codex')).toBe(true)
    expect(isAgentSessionHandleProvider('claude')).toBe(true)
    expect(isAgentSessionHandleProvider('gemini')).toBe(false)
    expect(isAgentSessionHandleProvider(undefined)).toBe(false)
  })

  it('keys a Claude handle by session id AND leaf, so two branches are two handles', () => {
    // Concurrent resumes branch one transcript silently; the session id alone cannot name a writer.
    const branchA = agentSessionProviderHandleKey(CLAUDE)
    const branchB = agentSessionProviderHandleKey(claudeProviderHandle('sess-1', 'leaf-2'))
    expect(branchA).not.toEqual(branchB)
    expect(agentSessionProviderHandleRoot(CLAUDE)).toEqual(
      agentSessionProviderHandleRoot(claudeProviderHandle('sess-1', 'leaf-2'))
    )
  })

  it('keys a Codex handle by thread id alone', () => {
    const codex: AgentSessionProviderHandle = codexProviderHandle('thread-1')
    expect(agentSessionProviderHandleKey(codex)).toBe('codex:"thread-1"')
    expect(agentSessionProviderHandleRoot(codex)).toBe('codex:"thread-1"')
    expect(agentSessionProviderHandlesEqual(codex, codexProviderHandle('thread-2'))).toBe(false)
  })

  it('distinguishes a null leaf from an empty-string leaf and rejects malformed handles', () => {
    expect(isAgentSessionProviderHandle(claudeProviderHandle('sess-1', null))).toBe(true)
    expect(isAgentSessionProviderHandle({ ...CLAUDE, resumeCursor: '' })).toBe(false)
    expect(isAgentSessionProviderHandle({ ...CLAUDE, nativeId: '' })).toBe(false)
    expect(isAgentSessionProviderHandle({ ...CLAUDE, nativeId: ' sess-1 ' })).toBe(false)
    // A stored typed shape is not an in-memory handle: it must be decoded first.
    expect(
      isAgentSessionProviderHandle({ provider: 'claude', sessionId: 'x', leafUuid: null })
    ).toBe(false)
    expect(isAgentSessionProviderHandle({ provider: 'gemini', sessionId: 'x' })).toBe(false)
  })

  it('uses collision-free keys when Claude ids contain delimiters', () => {
    const left = claudeProviderHandle('a#b', 'c')
    const right = claudeProviderHandle('a', 'b#c')
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
          handle: claudeProviderHandle('sess-2', 'leaf-9'),
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

  it('rejects a link minted under an older fence', () => {
    const chain = [link({ mintedAtFence: 5 })]
    expect(() =>
      appendAgentSessionProviderHandleLink(
        chain,
        link({
          linkId: 'link-2',
          origin: 'resumed',
          handle: claudeProviderHandle('sess-1', 'leaf-2'),
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
          handle: codexProviderHandle('thread-1'),
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
          handle: claudeProviderHandle('sess-1', 'leaf-2'),
          mintedAtFence: 2
        })
      )
    ).toThrow('agent_session_provider_handle_invalid')
  })

  it('never mutates the chain it was given', () => {
    const chain = [link()]
    appendAgentSessionProviderHandleLink(
      chain,
      link({
        linkId: 'link-2',
        origin: 'resumed',
        handle: claudeProviderHandle('sess-1', 'leaf-2'),
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
        handle: claudeProviderHandle('sess-1', 'leaf-2'),
        mintedAtFence: 2
      })
    )
    expect(findAgentSessionProviderHandleLink(chain, 'link-1')?.origin).toBe('created')
    expect(findAgentSessionProviderHandleLink(chain, 'missing')).toBeNull()
    expect(agentSessionProviderHandleChainHead(chain)?.linkId).toBe('link-2')
    expect(agentSessionProviderHandleChainHead([])).toBeNull()
  })

  it('rejects a persisted chain that holds a malformed link', () => {
    expect(isAgentSessionProviderHandleChain([{ ...link(), mintedAtFence: -1 }])).toBe(false)
    expect(isAgentSessionProviderHandleChain([{ ...link(), linkId: 'not a link id!' }])).toBe(false)
    expect(isAgentSessionProviderHandleChain([{ ...link(), forkedFromKey: 'claude:seed' }])).toBe(
      false
    )
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
  // What a resume-from-history builds: the create seeds an `adopted` head, then the provider's own
  // proof lands on top of it.
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

  it('elides a Claude re-proof of the identical adopted handle at the same fence', () => {
    const chain = [adopted()]
    const elided = appendAgentSessionProviderHandleLink(
      chain,
      link({
        linkId: 'claude-1-sess-1-empty-retry',
        origin: 'resumed',
        handle: claudeProviderHandle('sess-1', null),
        mintedAtFence: 1
      })
    )

    expect(elided).toEqual(chain)
  })

  it('appends a Codex resume only once the fence has moved', () => {
    const codexAdopted = link({
      linkId: 'codex-1-thread-1',
      origin: 'adopted',
      handle: codexProviderHandle('thread-1')
    })
    const reproved = link({
      linkId: 'codex-1-thread-1-retry',
      origin: 'resumed',
      handle: codexProviderHandle('thread-1'),
      mintedAtFence: 1
    })

    // Codex's thread id is the whole key, so a same-fence re-proof can only ever be a retry.
    expect(appendAgentSessionProviderHandleLink([codexAdopted], reproved)).toEqual([codexAdopted])
    expect(
      appendAgentSessionProviderHandleLink([codexAdopted], { ...reproved, mintedAtFence: 2 })
    ).toHaveLength(2)
  })

  it('refuses a second origin link on top of an adopted head', () => {
    // Nothing re-origins a chain: a create landing here would erase where the conversation came from.
    for (const origin of ['created', 'adopted'] as const) {
      expect(() =>
        appendAgentSessionProviderHandleLink(
          [adopted()],
          link({ linkId: 'claude-2-sess-1-leaf-1', origin, handle: CLAUDE, mintedAtFence: 2 })
        )
      ).toThrow('agent_session_provider_handle_invalid')
    }
  })

  it('refuses a resume that landed on another conversation entirely', () => {
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [adopted()],
        link({
          linkId: 'claude-1-sess-9-leaf-9',
          origin: 'resumed',
          handle: claudeProviderHandle('sess-9', 'leaf-9'),
          mintedAtFence: 1
        })
      )
    ).toThrow('agent_session_provider_handle_forked')
  })

  it('accepts an adopted head as a persisted chain', () => {
    expect(isAgentSessionProviderHandleChain([adopted()])).toBe(true)
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

  it('carries supersession only on a creation, and never as a persisted second link', () => {
    expect(
      appendAgentSessionProviderHandleLink([], replacement({ origin: 'created' }))
    ).toHaveLength(1)
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [created],
        replacement({ origin: 'resumed', handle: unsaved })
      )
    ).toThrow('agent_session_provider_handle_invalid')
    expect(isAgentSessionProviderHandleChain([created, replacement()])).toBe(false)
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

  it('is only ever a creation, and never opens a chain', () => {
    expect(() => appendAgentSessionProviderHandleLink([], fresh())).toThrow(
      'agent_session_provider_handle_invalid'
    )
    for (const origin of ['resumed', 'adopted', 'forked'] as const) {
      expect(() =>
        appendAgentSessionProviderHandleLink(
          [created, resumed],
          fresh({ origin, forkedFromKey: lost.key })
        )
      ).toThrow('agent_session_provider_handle_invalid')
    }
  })

  it('reads a reason a later build records, but no malformed one', () => {
    const later = fresh({ replaces: { ...lost, reason: 'transport-retired' } })
    expect(appendAgentSessionProviderHandleLink([created, resumed], later)).toHaveLength(3)
    for (const replaces of [
      { ...lost, reason: '' },
      { ...lost, reason: 'x'.repeat(65) },
      { ...lost, replacedAt: -1 },
      { key: lost.key, reason: lost.reason }
    ]) {
      expect(() =>
        appendAgentSessionProviderHandleLink(
          [created, resumed],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately malformed stored data the guard must refuse.
          fresh({ replaces: replaces as AgentSessionProviderHandleLink['replaces'] })
        )
      ).toThrow('agent_session_provider_handle_invalid')
    }
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

  it('refuses a supersession key that names no creation in the chain', () => {
    expect(() =>
      appendAgentSessionProviderHandleLink(
        [created, resumed],
        fresh({ supersedesKey: agentSessionProviderHandleKey(acp('s-9')) })
      )
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
