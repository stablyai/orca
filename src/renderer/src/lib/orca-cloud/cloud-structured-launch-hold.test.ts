// @vitest-environment happy-dom
// CHAT-BANNERS (PR-B): a structured chat on an Orca Cloud host whose agent isn't set up (or whose
// sign-in expired) holds before `agentSession.create`: it never launches until the strip releases it,
// and a cancelled hold creates nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StructuredAgentSessionLaunchIntent } from '../agent-session/launch/structured-agent-session-launch-intent'
import type * as LaunchHoldModule from './cloud-agent-launch-hold'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  abandon: vi.fn(),
  cloudHost: true,
  needsHold: true
}))

vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudExecutionHostId: () => mocks.cloudHost,
  isOrcaCloudEnvironmentId: () => mocks.cloudHost
}))
vi.mock('./orca-cloud-agent-accounts-store', () => ({
  readOrcaCloudAgentAccounts: () => ({ load: { kind: 'ready' } }),
  ensureFreshOrcaCloudAgentAccounts: async () => ({ load: { kind: 'ready' } }),
  isOrcaCloudAgentAccountsFresh: () => true,
  subscribeOrcaCloudAgentAccounts: () => () => undefined,
  useOrcaCloudAgentAccounts: () => ({ load: { kind: 'ready' } })
}))
vi.mock('./orca-cloud-agent-accounts-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orcaCloudAgentCoverageFromAccounts: () => ({ kind: 'notSetUp' })
}))
vi.mock('./cloud-agent-launch-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchHoldModule>()),
  cloudAgentLaunchNeedsHold: () => mocks.needsHold
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  supportsStructuredAgentSessionCreateMessage: async () => false,
  supportsStructuredAgentSessionCreateOptionsMode: async () => false,
  structuredAgentSessionHostSupports: async () => false
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'admitted' })
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: async () => ({ kind: 'allowed' })
}))
vi.mock('@/store/workspace-layout/frames/frame-drawn-chat-tab-placement', () => ({
  withFrameDrawnChatTabPlacement: (intent: { params: unknown }) => intent.params
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-abandon', () => ({
  abandonStructuredAgentSessionLaunchIntent: mocks.abandon
}))

const { launchStructuredAgentSession } =
  await import('@/lib/agent-session/launch/structured-agent-session-launch-create-call')
const { StructuredAgentSessionCreateAbandonedError } =
  await import('@/lib/agent-session/launch/structured-agent-session-launch-errors')
const { readCloudAgentHold, releaseCloudAgentHold } = await import('./cloud-agent-launch-hold')
const { structuredCloudHoldKey } = await import('./cloud-structured-launch-hold')

const SESSION = 'claude_1111_2222'
const HOST: ExecutionHostId = 'runtime:env-cloud'

function intent(agent: string = 'claude'): StructuredAgentSessionLaunchIntent {
  const value = {
    sessionId: SESSION,
    worktreeId: 'wt-1',
    executionHostId: HOST,
    target: { kind: 'environment', environmentId: 'env-cloud' },
    agent,
    params: { envelope: {}, worktree: '/repo', agent },
    createPrepared: true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only these fields with every host call mocked.
  return value as unknown as StructuredAgentSessionLaunchIntent
}

/** Lets every pending microtask (the host checks before the hold) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue({
    ok: true,
    value: { sessionId: SESSION, fence: 1, page: { submissions: [] } }
  })
  mocks.abandon.mockReset()
  mocks.cloudHost = true
  mocks.needsHold = true
})
afterEach(() => {
  if (readCloudAgentHold(structuredCloudHoldKey(SESSION))) {
    releaseCloudAgentHold(structuredCloudHoldKey(SESSION), 'cancel')
  }
})

describe('a structured chat on Orca Cloud with Claude not set up', () => {
  it('never creates its session while held; Start on the strip creates it', async () => {
    const launched = launchStructuredAgentSession(intent())
    await settle()
    const hold = readCloudAgentHold(structuredCloudHoldKey(SESSION))
    expect(hold).toMatchObject({ agent: 'claude', reason: 'notSetUp' })
    expect(mocks.call).not.toHaveBeenCalled()
    releaseCloudAgentHold(structuredCloudHoldKey(SESSION), 'proceed')
    await expect(launched).resolves.toMatchObject({ sessionId: SESSION })
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls[0]?.[1]).toBe('agentSession.create')
  })

  it('cancel on the strip creates nothing and abandons the launch', async () => {
    const launched = launchStructuredAgentSession(intent())
    await settle()
    releaseCloudAgentHold(structuredCloudHoldKey(SESSION), 'cancel')
    await expect(launched).rejects.toBeInstanceOf(StructuredAgentSessionCreateAbandonedError)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.abandon).toHaveBeenCalledTimes(1)
  })

  it('a chat closed while held creates nothing once released', async () => {
    let closed = false
    const launched = launchStructuredAgentSession(intent(), undefined, false, () => closed)
    await settle()
    closed = true
    releaseCloudAgentHold(structuredCloudHoldKey(SESSION), 'proceed')
    await expect(launched).rejects.toBeInstanceOf(StructuredAgentSessionCreateAbandonedError)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

describe('launches that never hold', () => {
  it('a ready account creates at once, with no hold', async () => {
    mocks.needsHold = false
    await launchStructuredAgentSession(intent())
    expect(readCloudAgentHold(structuredCloudHoldKey(SESSION))).toBeNull()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('a chat on a host that is not Orca Cloud', async () => {
    mocks.cloudHost = false
    await launchStructuredAgentSession(intent())
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('an agent other than Claude or Codex', async () => {
    await launchStructuredAgentSession(intent('gemini'))
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
})
