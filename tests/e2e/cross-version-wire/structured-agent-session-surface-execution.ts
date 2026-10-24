import { expect, vi } from 'vitest'
import { AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
import { resetStructuredAgentSessionClosesBeforeCreateForTests } from '../../../src/main/runtime/rpc/methods/structured-agent-session-close-before-create'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { inPlaceSwitchCapability } from '../../../src/shared/structured-agent-cli-conversation-adoption'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../src/shared/agent-session-journal-types'
import type { AiVaultSessionResumePreparation } from '../../../src/shared/ai-vault-resume-preparation'
import { structuredSwitchSource } from './structured-agent-session-host-fixture'
import {
  attachParams,
  ATTENTION_READ,
  paramsFor,
  SESSION,
  WORKSPACE,
  THREAD,
  SWITCH_TO_TERMINAL_METHOD,
  SWITCH_TO_CHAT_METHOD,
  STRUCTURED_CALLS
} from './structured-agent-session-surface-manifest'
import type {
  AgentSessionWireBuild,
  RpcClientIdentity,
  RpcReply
} from './versioned-agent-session-wire'

export function runtimeStub(overrides: Record<string, unknown> = {}): unknown {
  // A fresh runtime remembers no chat closed before its create; scenarios reuse one session id.
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  const subscriptions = new RuntimeSubscriptionRegistry()
  return {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    ensureStructuredAgentSessionHost: async () => undefined,
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    structuredAgentSessionLaunchSeedOptions: () => undefined,
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    subscribeStructuredAgentAvailability: (read: (agents: unknown[]) => void) => {
      read([])
      return () => {}
    },
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    registerOwnedSubscriptionCleanup: subscriptions.registerOwned.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    cleanupSubscriptionsByPrefix: subscriptions.cleanupByPrefix.bind(subscriptions),
    ...overrides
  }
}

/** Every reply one call produced. Streaming methods answer more than once, and a
 *  refusal has to arrive as a reply rather than as silence. */
export async function callBuild(
  build: AgentSessionWireBuild,
  method: string,
  params: unknown,
  client: RpcClientIdentity,
  runtime: unknown = runtimeStub()
): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build.createDispatcher(runtime).dispatchStreaming(
    { id: `request-${method}`, authToken: 'cross-version-token', method, params },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the build's RPC dispatcher serializes its own reply; result/error shape is asserted by each surface case.
    (raw) => replies.push(JSON.parse(raw) as RpcReply),
    client
  )
  return replies
}

/**
 * The one thing this suite exists to guarantee, written once and applied per
 * build: every method the manifest declares is not merely registered but reaches
 * its host method on this call, answers, and answers with its declared result.
 *
 * Written as a helper rather than inline because a build passing it is the claim,
 * and each skew that registers the surface owes the same claim — a check that
 * covers one method leaves the rest registered-but-unusable behind a green suite.
 */
export async function expectDeclaredSurfaceExecutes(
  build: AgentSessionWireBuild,
  hostCalls: Record<string, ReturnType<typeof vi.fn>>,
  clientCapabilities: readonly string[]
): Promise<void> {
  const retirement = vi.fn()
  const saved = await structuredSwitchSource(SESSION, WORKSPACE, THREAD)
  const preparation = vi.fn<AiVaultSessionResumePreparation>(async () => ({
    useRealCodexHome: false
  }))
  const runtime = runtimeStub({
    retireStructuredAttention: retirement,
    prepareAiVaultSessionResume: preparation
  })
  try {
    for (const { method, hostMethod, result, clientCapability } of STRUCTURED_CALLS) {
      const switching = method === SWITCH_TO_TERMINAL_METHOD || method === SWITCH_TO_CHAT_METHOD
      hostCalls.getRecord.mockImplementation((sessionId: string) =>
        switching && sessionId === SESSION ? saved.record : null
      )
      if (method === SWITCH_TO_TERMINAL_METHOD) {
        const snapshot: AgentJournalSnapshot = {
          sessionId: SESSION,
          cursor: { epoch: 'epoch-a', sequence: 1 },
          submissions: [],
          items: [
            {
              itemId: agentJournalItemKey({
                provider: 'codex',
                threadId: THREAD,
                turnId: 'turn-1',
                ordinal: 0
              }),
              revision: 1,
              sequence: 1,
              observedAt: 1_000,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'Saved prompt' }]
              }
            }
          ]
        }
        hostCalls.journalSnapshot.mockReturnValueOnce(snapshot)
      }
      const atRestCreate =
        method === 'agentSession.create' &&
        build.capabilities.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY) &&
        clientCapabilities.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
      const expectedHostMethod = atRestCreate ? 'create' : hostMethod
      const otherCreateMethod =
        method === 'agentSession.create' ? (atRestCreate ? 'attach' : 'create') : null
      // Two methods share one host method, so "has been called" would already be
      // true from the earlier one: only this call's own delta pins the pairing.
      const before = expectedHostMethod ? hostCalls[expectedHostMethod].mock.calls.length : 0
      const otherBefore = otherCreateMethod ? hostCalls[otherCreateMethod].mock.calls.length : 0
      const replies = await callBuild(
        build,
        method,
        paramsFor(method),
        { clientKind: 'runtime', clientCapabilities },
        runtime
      )
      if (clientCapability && !clientCapabilities.includes(clientCapability)) {
        expect(replies).toMatchObject([
          {
            ok: false,
            error: { message: expect.stringContaining('structured_agent_session_unsupported') }
          }
        ])
        if (expectedHostMethod) {
          expect(hostCalls[expectedHostMethod].mock.calls.length).toBe(before)
        }
        continue
      }
      if (expectedHostMethod) {
        expect(
          hostCalls[expectedHostMethod].mock.calls.length - before,
          `${build.label}: ${method} did not reach the host: ${JSON.stringify(replies)}`
        ).toBe(1)
      }
      if (otherCreateMethod) {
        expect(hostCalls[otherCreateMethod].mock.calls.length - otherBefore).toBe(0)
      }
      if (method === 'agentSession.acknowledgeAttention') {
        expect(retirement).toHaveBeenCalledExactlyOnceWith(ATTENTION_READ)
      }
      if (method === SWITCH_TO_CHAT_METHOD) {
        expect(hostCalls.switchToChat).toHaveBeenLastCalledWith(SESSION)
      }
      if (method === SWITCH_TO_TERMINAL_METHOD) {
        expect(hostCalls.switchToTerminal).toHaveBeenLastCalledWith(SESSION)
        expect(preparation).toHaveBeenCalledExactlyOnceWith({
          agent: 'codex',
          sessionId: THREAD,
          filePath: saved.source.filePath,
          codexHome: saved.source.codexHome,
          executionHostId: 'local'
        })
        expect(preparation.mock.invocationCallOrder[0]).toBeLessThan(
          hostCalls.switchToTerminal.mock.invocationCallOrder[0]
        )
        expect(replies[0]).toMatchObject({ ok: true, result: { source: saved.source } })
      }
      for (const reply of replies) {
        expect(
          reply,
          `${build.label}: ${method} was refused: ${JSON.stringify(reply)}`
        ).toMatchObject({ ok: true })
      }
      if (result) {
        // The declared answer, not merely a non-refusal: a handler that is
        // registered and returns an execution error, or hands back someone else's
        // envelope, fails here rather than passing as "reached the host".
        expect(replies, `${build.label}: ${method} must answer exactly once`).toHaveLength(1)
        expect(replies[0], `${build.label}: ${method} answered off-contract`).toMatchObject({
          ok: true,
          result
        })
      }
    }
  } finally {
    hostCalls.getRecord.mockReturnValue(null)
    await saved.dispose()
  }
}

export function expectItemDetailAndSwitchNegotiation(
  builds: readonly AgentSessionWireBuild[]
): void {
  expect(builds[0]?.capabilities).toContain(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)
  expect(builds[0]?.capabilities).toContain(inPlaceSwitchCapability('codex'))
  for (const build of builds) {
    expect(build.capabilities.includes(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)).toBe(
      build.methodNames.includes('agentSession.item')
    )
    for (const method of [SWITCH_TO_TERMINAL_METHOD, SWITCH_TO_CHAT_METHOD]) {
      expect(build.capabilities.includes(inPlaceSwitchCapability('codex'))).toBe(
        build.methodNames.includes(method)
      )
    }
  }
}
