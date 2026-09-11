// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    // Present so an ablation that routes a stage back to the local applier fails on its own
    // assertion rather than on a missing store method.
    setState: (updater: unknown) => {
      Object.assign(
        mocks.state,
        typeof updater === 'function'
          ? (updater as (state: Record<string, unknown>) => unknown)(mocks.state)
          : updater
      )
    },
    subscribe: () => () => undefined
  }
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'
import {
  startStructuredAgentLaunch,
  type StructuredAgentLaunchResult
} from '@/lib/structured-agent-session-launch'

const ENVIRONMENT_ID = 'env-1'
const PINNED_REVISION = 7
const REPAIRED_REVISION = 8

type RecordedCall = {
  transport: 'local' | 'environment'
  method: string
  selector?: string
  expectedEnvironmentPairingRevision?: number
}

/** A scripted host refusal, delivered as the wire failure the real transport would return. */
class ScriptedRuntimeRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

let calls: RecordedCall[] = []
let responders: Record<string, (params: unknown) => unknown> = {}
let worktreeId = ''
let worktreeCounter = 0

function ownWorktreeWith(executionHostId: string): void {
  mocks.state = {
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: executionHostId,
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    seedNativeChatLaunchDraft: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    scheduleAgentStatusFreshness: vi.fn()
  }
}

/**
 * Re-owns the workspace after every hop. A stage that re-resolved instead of reading the pinned
 * owner would answer `local` or `env-2` here, and the transport would record it as such.
 */
function churnWorkspaceOwnership(): void {
  ownWorktreeWith(calls.length % 2 === 0 ? 'local' : 'runtime:env-2')
}

function reply(method: string, params: unknown): RuntimeRpcResponse<unknown> {
  const responder = responders[method]
  if (!responder) {
    throw new Error(`unscripted runtime method: ${method}`)
  }
  try {
    return { id: 'call', ok: true, result: responder(params), _meta: { runtimeId: 'runtime-1' } }
  } catch (error) {
    if (error instanceof ScriptedRuntimeRefusal) {
      return { id: 'call', ok: false, error: { code: error.code, message: error.code } }
    }
    throw error
  }
}

function installFakeTransport(): void {
  const currentRevision = (selector: string): number | undefined =>
    selector === ENVIRONMENT_ID ? revisionByEnvironment[ENVIRONMENT_ID] : 1
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    runtime: {
      call: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.push({ transport: 'local', method })
        const response = reply(method, params)
        churnWorkspaceOwnership()
        return response
      }
    },
    runtimeEnvironments: {
      call: async (args: {
        selector: string
        method: string
        params?: unknown
        expectedEnvironmentPairingRevision?: number
      }) => {
        calls.push({
          transport: 'environment',
          method: args.method,
          selector: args.selector,
          expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
        })
        if (args.expectedEnvironmentPairingRevision !== currentRevision(args.selector)) {
          // What the real client does once the id names a machine the caller never chose.
          return {
            id: 'call',
            ok: false,
            error: { code: 'environment_unavailable', message: 'runtime environment unavailable' }
          }
        }
        const response = reply(args.method, args.params)
        churnWorkspaceOwnership()
        return response
      }
    }
  }
}

const revisionByEnvironment: Record<string, number> = {}

function pairEnvironment(pairingRevision: number): void {
  revisionByEnvironment[ENVIRONMENT_ID] = pairingRevision
  replaceRuntimeEnvironmentRevisions([
    { id: ENVIRONMENT_ID, createdAt: 1, pairingRevision },
    { id: 'env-2', createdAt: 1, pairingRevision: 1 }
  ])
}

function callsTo(method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method)
}

/** One stage, one assertion: the call it made went to the pinned host at the pinned revision. */
function expectStageAddressedPinnedOwner(method: string, occurrence = 0): void {
  expect(callsTo(method)[occurrence]).toEqual({
    transport: 'environment',
    method,
    selector: ENVIRONMENT_ID,
    expectedEnvironmentPairingRevision: PINNED_REVISION
  })
}

function publishedSnapshot(sessionId: string): unknown {
  return {
    worktree: worktreeId,
    tabs: [{ type: 'agent-session', sessionId }]
  }
}

function acceptedSend(): unknown {
  return { ok: true, value: { submission: { dispatchState: 'accepted' } } }
}

function startLaunch(options: { prompt?: string } = {}): StructuredAgentLaunchResult {
  const launch = startStructuredAgentLaunch(worktreeId, 'codex', options)
  // Captured before the first await so the scripted host can publish the id the launch chose.
  launchedSessionId = launch.sessionId
  return launch
}

let launchedSessionId = ''

beforeEach(() => {
  worktreeCounter += 1
  worktreeId = `repo-1::/repo/wt-${worktreeCounter}`
  calls = []
  responders = {}
  launchedSessionId = ''
  localStorage.clear()
  resetWebSessionFocusIntentForTests()
  clearRuntimeCompatibilityCache()
  pairEnvironment(PINNED_REVISION)
  markRuntimeEnvironmentCompatible(ENVIRONMENT_ID)
  ownWorktreeWith(`runtime:${ENVIRONMENT_ID}`)
  installFakeTransport()
})

describe('a launch pinned to a peer host', () => {
  beforeEach(() => {
    responders = {
      'agentSession.createSupport': () => ({ supported: true }),
      'agentSession.create': () => ({
        ok: true,
        value: { sessionId: launchedSessionId, fence: 1 }
      }),
      'session.tabs.listAll': () => ({ snapshots: [publishedSnapshot(launchedSessionId)] }),
      'agentSession.send': () => acceptedSend()
    }
  })

  it('records the focus intent under the owner that will publish the session', () => {
    startLaunch()

    expect(
      peekWebSessionFocusIntent(
        { environmentId: ENVIRONMENT_ID, pairingRevision: PINNED_REVISION },
        worktreeId
      )?.hostTabId
    ).toBe(`agent-session:${launchedSessionId}`)
    expect(
      peekWebSessionFocusIntent({ environmentId: LOCAL_STRUCTURED_SESSION_OWNER }, worktreeId)
    ).toBeNull()
  })

  it('asks the pinned owner whether it supports creating the session', async () => {
    await startLaunch().launchResult

    expectStageAddressedPinnedOwner('agentSession.createSupport')
  })

  it('creates the session on the pinned owner', async () => {
    await startLaunch().launchResult

    expectStageAddressedPinnedOwner('agentSession.create')
  })

  it('verifies publication against the pinned owner inventory', async () => {
    await startLaunch().launchResult

    expectStageAddressedPinnedOwner('session.tabs.listAll')
  })

  it('delivers the launch prompt to the pinned owner', async () => {
    const launch = startLaunch({ prompt: 'review this' })
    await launch.launchResult
    await launch.promptDeliveryResult

    expectStageAddressedPinnedOwner('agentSession.send')
  })
})

describe('a pinned launch that has to reconcile', () => {
  it('reads the recovered history from the pinned owner', async () => {
    let created = 0
    responders = {
      'agentSession.createSupport': () => ({ supported: true }),
      'agentSession.create': () => {
        created += 1
        throw new ScriptedRuntimeRefusal('runtime_busy')
      },
      'session.tabs.listAll': () => ({ snapshots: [publishedSnapshot(launchedSessionId)] }),
      'agentSession.history': () => ({ ok: true, page: { fence: 3 } })
    }

    await expect(startLaunch().launchResult).resolves.toMatchObject({ fence: 3 })
    expect(created).toBe(1)
    expectStageAddressedPinnedOwner('agentSession.history')
  })

  it('retries the create on the pinned owner rather than re-resolving the workspace', async () => {
    let created = 0
    let listed = 0
    responders = {
      'agentSession.createSupport': () => ({ supported: true }),
      'agentSession.create': () => {
        created += 1
        if (created === 1) {
          throw new ScriptedRuntimeRefusal('runtime_busy')
        }
        return { ok: true, value: { sessionId: launchedSessionId, fence: 2 } }
      },
      'session.tabs.listAll': () => {
        listed += 1
        return { snapshots: listed === 1 ? [] : [publishedSnapshot(launchedSessionId)] }
      },
      'agentSession.history': () => ({ ok: true, page: {} })
    }

    await expect(startLaunch().launchResult).resolves.toMatchObject({ fence: 2 })
    expect(created).toBe(2)
    expectStageAddressedPinnedOwner('agentSession.create', 1)
  })

  it('clears the focus intent it recorded when the pinned owner refuses', async () => {
    responders = { 'agentSession.createSupport': () => ({ supported: false }) }
    const ownerKey = { environmentId: ENVIRONMENT_ID, pairingRevision: PINNED_REVISION }

    const launch = startLaunch()
    expect(peekWebSessionFocusIntent(ownerKey, worktreeId)).not.toBeNull()
    await expect(launch.launchResult).rejects.toThrow()

    expect(peekWebSessionFocusIntent(ownerKey, worktreeId)).toBeNull()
  })
})

describe('a pinned owner that is re-paired mid-launch', () => {
  it('reports the host unavailable instead of re-resolving or falling back to local', async () => {
    responders = {
      'agentSession.createSupport': () => ({ supported: true }),
      'agentSession.create': () => {
        // The id now names a machine this launch never chose.
        pairEnvironment(REPAIRED_REVISION)
        return { ok: true, value: { sessionId: launchedSessionId, fence: 1 } }
      },
      'session.tabs.listAll': () => ({ snapshots: [publishedSnapshot(launchedSessionId)] })
    }

    await expect(startLaunch().launchResult).rejects.toThrow()

    expect(calls.some((call) => call.transport === 'local')).toBe(false)
    expect(
      calls.every(
        (call) =>
          call.selector === ENVIRONMENT_ID &&
          call.expectedEnvironmentPairingRevision === PINNED_REVISION
      )
    ).toBe(true)
    expect(callsTo('session.tabs.listAll')).toHaveLength(1)
  })
})
