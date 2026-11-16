import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

const state = vi.hoisted(() => {
  const value: {
    needsHold: boolean | null
    mainSays: boolean
    inside: boolean
    release: ((outcome: 'proceed' | 'cancel') => void) | null
  } = { needsHold: true, mainSays: true, inside: false, release: null }
  return value
})

vi.mock('./agent-sign-in-spawn-gate', () => ({
  agentSignInGateRequest: () => ({
    key: 'pane-1',
    agent: 'claude',
    prompt: null,
    environmentId: 'env-paired'
  })
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({
  cloudAgentLaunchNeedsHold: () => state.needsHold,
  cloudAgentSignsInInsideWorkspace: () => state.inside,
  holdCloudAgentLaunch: () =>
    new Promise((resolve) => {
      state.release = resolve
    })
}))
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentForLaunch: async () => state.mainSays
}))
// The renderer catalog has no flag for the new pairing yet (the lag this gate must survive).
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ runtimeEnvironments: [] }) }
}))

const { installCloudAgentCredentialGate } = await import('./cloud-agent-credential-spawn-gate')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function session() {
  // `start` is the launch behind #40228's per-host gate; `ungated` the one in front of it.
  const start = vi.fn(async (_startup?: unknown, _options?: unknown) => 'pty-1')
  const ungated = vi.fn(async (_startup?: unknown, _options?: unknown) => 'pty-own-sign-in')
  const value = {
    startFreshSpawn: start,
    startFreshSpawnWithoutSignInGate: ungated,
    disposed: false,
    pendingSpawnKey: 'k',
    tabGeneration: 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only these fields
  installCloudAgentCredentialGate(value as unknown as ConnectPanePtySession)
  return { value, start, ungated }
}

describe('cloud agent credential spawn gate', () => {
  beforeEach(() => {
    state.needsHold = true
    state.mainSays = true
    state.inside = false
    state.release = null
  })

  it('a paired-from-birth pane with no credential never spawns Claude while the catalog flag is absent', async () => {
    const { value, start } = session()
    const spawned = value.startFreshSpawn(undefined, {})
    await flush()
    expect(start).not.toHaveBeenCalled()
    expect(state.release).not.toBeNull()
    state.release?.('proceed')
    await expect(spawned).resolves.toBe('pty-1')
    expect(start).toHaveBeenCalledOnce()
  })

  it('a covered credential spawns at once', async () => {
    state.needsHold = false
    const { value, start } = session()
    await expect(value.startFreshSpawn(undefined, {})).resolves.toBe('pty-1')
    expect(start).toHaveBeenCalledOnce()
    expect(state.release).toBeNull()
  })

  it('a server main does not know as Orca Cloud spawns without a hold', async () => {
    state.mainSays = false
    const { value, start } = session()
    await expect(value.startFreshSpawn(undefined, {})).resolves.toBe('pty-1')
    expect(start).toHaveBeenCalledOnce()
    expect(state.release).toBeNull()
  })

  it('signing in inside the workspace starts the agent past every gate, so its own sign-in shows', async () => {
    state.needsHold = false
    state.inside = true
    const { value, start, ungated } = session()
    await expect(value.startFreshSpawn(undefined, {})).resolves.toBe('pty-own-sign-in')
    expect(ungated).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(state.release).toBeNull()
  })

  it('signing in inside the workspace never skips the per-host gate on a host that is not Orca Cloud', async () => {
    state.needsHold = false
    state.inside = true
    state.mainSays = false
    const { value, start, ungated } = session()
    await expect(value.startFreshSpawn(undefined, {})).resolves.toBe('pty-1')
    expect(start).toHaveBeenCalledOnce()
    expect(ungated).not.toHaveBeenCalled()
  })

  it('a launch held on "Set up once" whose person chooses to sign in inside starts past the per-host gate', async () => {
    const { value, start, ungated } = session()
    const spawned = value.startFreshSpawn(undefined, {})
    await flush()
    expect(state.release).not.toBeNull()
    state.inside = true
    state.release?.('proceed')
    await expect(spawned).resolves.toBe('pty-own-sign-in')
    expect(ungated).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })
})
