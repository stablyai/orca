import { expect, test } from 'vitest'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  appendAgentSessionProviderHandleLink,
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from '../../../src/shared/agent-session-provider-handle'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../../src/shared/agent-session-record-stored-form'
import type { AgentSessionRecord } from '../../../src/shared/agent-session-record'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// The oldest release native chat records must stay readable in, and the newest stable one.
const OLDEST_REF = 'v1.4.220'
// Every build before this one refused to append a link past this many.
const LEGACY_CHAIN_LIMIT = 256

type Agent = 'claude' | 'codex'

const handleFor = (agent: Agent, fence: number): AgentSessionProviderHandle =>
  agent === 'claude'
    ? claudeProviderHandle('saved-claude', `leaf-${fence}`)
    : codexProviderHandle('saved-codex')

const resumed = (agent: Agent, fence: number): AgentSessionProviderHandleLink => ({
  linkId: `${agent}-${fence}`,
  handle: handleFor(agent, fence),
  origin: 'resumed',
  mintedAtFence: fence,
  observedAt: fence * 1_000
})

/** A live chat as this build stores it after `opens` reopens, starting from `chain`. */
function reopened(agent: Agent, chain: AgentSessionProviderHandleLink[], opens: number) {
  let next = chain
  const first = (chain.at(-1)?.mintedAtFence ?? 0) + 1
  for (let fence = first; fence < first + opens; fence += 1) {
    next = appendAgentSessionProviderHandleLink(next, resumed(agent, fence))
  }
  const head = next.at(-1)
  const fixture = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: `chat-${agent}`,
      runtimeFence: head?.mintedAtFence,
      provenHandleLinkId: head?.linkId
    })
  )
  const record: AgentSessionRecord = {
    ...fixture,
    provider: agent,
    accountHome:
      agent === 'claude' ? fixture.accountHome : { variable: 'CODEX_HOME', path: '/home/u/.codex' },
    providerHandleChain: next
  }
  return encodeAgentSessionRecord(record)
}

function created(agent: Agent): AgentSessionProviderHandleLink {
  return { ...resumed(agent, 1), origin: 'created' }
}

/** What an older build wrote for a chat reopened until it hit its limit. */
function filledByOlderBuild(agent: Agent): AgentSessionProviderHandleLink[] {
  return Array.from({ length: LEGACY_CHAIN_LIMIT }, (_value, index) =>
    index === 0 ? created(agent) : resumed(agent, index + 1)
  )
}

function oldFunction(module: Record<string, unknown>, name: string, ref: string) {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`${ref} exports no ${name}`)
  }
  return value
}

test.each([...new Set([OLDEST_REF, resolveBaselineReleaseRef()])])(
  '%s keeps opening a chat this build reopened past the old limit, and the reverse',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const [records, chains] = await Promise.all([
      importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts'),
      importReleaseCheckoutModule(checkout, 'src/shared/agent-session-provider-handle.ts')
    ])
    const isRecord = oldFunction(records, 'isPersistedAgentSessionRecord', ref)
    const oldAppend = oldFunction(chains, 'appendAgentSessionProviderHandleLink', ref)

    for (const agent of ['claude', 'codex'] as const) {
      // This build: reopened far past the old limit, and a chat the older build had filled.
      const fresh = reopened(agent, [created(agent)], LEGACY_CHAIN_LIMIT + 44)
      const healed = reopened(agent, filledByOlderBuild(agent), 1)
      expect(fresh.providerHandleChain).toHaveLength(2)
      expect(healed.providerHandleChain).toHaveLength(LEGACY_CHAIN_LIMIT)
      for (const row of [fresh, healed]) {
        const stored = JSON.parse(JSON.stringify(row))
        expect(isRecord(stored)).toBe(true)
      }

      // The older build resumes the chat once more; its stored links are its in-memory form.
      const fence = (fresh.providerHandleChain.at(-1)?.mintedAtFence ?? 0) + 1
      const [link] = encodePersistedAgentSessionProviderHandleChain([resumed(agent, fence)])
      const olderChain: unknown = oldAppend(fresh.providerHandleChain, link)
      expect(olderChain).toHaveLength(3)

      // Upgraded again: this build reads what the older one wrote and resumes in place.
      const back = decodePersistedAgentSessionProviderHandleChain(
        JSON.parse(JSON.stringify(olderChain))
      )
      if (!back) {
        throw new Error(`this build must read the chain ${ref} wrote`)
      }
      const again = appendAgentSessionProviderHandleLink(back, resumed(agent, fence + 1))
      expect(again).toHaveLength(3)
      expect(again.at(-1)?.linkId).toBe(`${agent}-${fence + 1}`)
    }
  },
  300_000
)
