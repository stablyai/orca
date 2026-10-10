import { describe, expect, it } from 'vitest'
import {
  appendAgentSessionProviderHandleLink,
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain,
  isAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import { agentSessionProviderHandleKey } from './agent-session-provider-handle-encoding'

// Every build before this one refused to append a link past this many.
const LEGACY_CHAIN_LIMIT = 256

const acp = (nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent: 'grok',
  nativeId
})

function link(
  nativeId: string,
  fence: number,
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: `link-${fence}`,
    handle: acp(nativeId),
    origin: 'resumed',
    mintedAtFence: fence,
    observedAt: fence * 1_000,
    ...overrides
  }
}

const replacing = (nativeId: string, lost: string, fence: number) =>
  link(nativeId, fence, {
    origin: 'created',
    replaces: {
      key: agentSessionProviderHandleKey(acp(lost)),
      reason: 'restore-failed',
      replacedAt: fence * 1_000
    }
  })

/** What an older build wrote: the creation, then one resume link per reopen. */
function legacyChain(length: number): AgentSessionProviderHandleLink[] {
  return Array.from({ length }, (_value, index) =>
    link('s-1', index + 1, { origin: index === 0 ? 'created' : 'resumed' })
  )
}

describe('a resume moves the current attachment in place', () => {
  it('keeps the creation and one current link however often the chat reopens', () => {
    let chain = appendAgentSessionProviderHandleLink([], link('s-1', 1, { origin: 'created' }))
    for (let fence = 2; fence < 1_000; fence += 1) {
      chain = appendAgentSessionProviderHandleLink(chain, link('s-1', fence))
    }
    expect(chain.map((entry) => [entry.linkId, entry.origin])).toEqual([
      ['link-1', 'created'],
      ['link-999', 'resumed']
    ])
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
  })

  it('resumes a chain an older build already filled, without growing it', () => {
    const full = legacyChain(LEGACY_CHAIN_LIMIT)
    const next = appendAgentSessionProviderHandleLink(full, link('s-1', 300))
    expect(next).toHaveLength(LEGACY_CHAIN_LIMIT)
    expect(next.at(-1)?.linkId).toBe('link-300')
    expect(next.at(-2)).toEqual(full.at(-2))
    expect(isAgentSessionProviderHandleChain(next)).toBe(true)
  })

  it('still refuses a resume under an older fence than the link it moves', () => {
    const chain = [link('s-1', 1, { origin: 'created' }), link('s-1', 5)]
    expect(() => appendAgentSessionProviderHandleLink(chain, link('s-1', 4))).toThrow(
      'agent_session_provider_handle_stale_fence'
    )
  })

  it('refuses a persisted chain that names one link id twice, however far apart', () => {
    const chain = [
      link('s-1', 1, { origin: 'created' }),
      replacing('s-2', 's-1', 2),
      link('s-2', 3, { linkId: 'link-1' })
    ]
    expect(isAgentSessionProviderHandleChain(chain)).toBe(false)
    expect(isAgentSessionProviderHandleChain(chain.slice(0, 2))).toBe(true)
  })

  it('treats a retry at the same fence as the same proof', () => {
    const chain = [link('s-1', 1, { origin: 'created' }), link('s-1', 5)]
    expect(appendAgentSessionProviderHandleLink(chain, link('s-1', 5))).toEqual(chain)
  })
})

describe('switching to a fresh session never runs out of room', () => {
  it.each([LEGACY_CHAIN_LIMIT - 1, LEGACY_CHAIN_LIMIT])(
    'replaces the session of a %i-link chain, and the next resume still works',
    (length) => {
      const replaced = appendAgentSessionProviderHandleLink(
        legacyChain(length),
        replacing('s-2', 's-1', 400)
      )
      expect(replaced).toHaveLength(length + 1)
      const resumed = appendAgentSessionProviderHandleLink(replaced, link('s-2', 401))
      const again = appendAgentSessionProviderHandleLink(resumed, link('s-2', 402))
      expect(again).toHaveLength(length + 2)
      expect(again.at(-2)?.replaces?.key).toBe(agentSessionProviderHandleKey(acp('s-1')))
      expect(again.at(-1)).toMatchObject({ linkId: 'link-402', origin: 'resumed' })
      expect(
        decodePersistedAgentSessionProviderHandleChain(
          encodePersistedAgentSessionProviderHandleChain(again)
        )
      ).toEqual(again)
    }
  )

  it('keeps every switch, past any old limit, and reads them all back', () => {
    let chain = appendAgentSessionProviderHandleLink([], link('s-0', 1, { origin: 'created' }))
    for (let session = 1; session <= LEGACY_CHAIN_LIMIT; session += 1) {
      chain = appendAgentSessionProviderHandleLink(
        chain,
        replacing(`s-${session}`, `s-${session - 1}`, session * 2)
      )
      chain = appendAgentSessionProviderHandleLink(chain, link(`s-${session}`, session * 2 + 1))
    }
    expect(chain).toHaveLength(2 * LEGACY_CHAIN_LIMIT + 1)
    expect(chain.filter((entry) => entry.replaces)).toHaveLength(LEGACY_CHAIN_LIMIT)
    expect(
      decodePersistedAgentSessionProviderHandleChain(
        encodePersistedAgentSessionProviderHandleChain(chain)
      )
    ).toEqual(chain)
  })
})
