// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { resetSkillDiscoveryCacheForTests } from './installed-agent-skill-discovery'
import { useInstalledAgentSkill } from './useInstalledAgentSkills'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  clearRuntimeCompatibilityCache: vi.fn(),
  clearRecentRuntimeCompatibilityFailure: vi.fn()
}))
vi.mock('@/runtime/restored-client-hosted-browser-host-attach', () => ({
  ensureBrowserClientHostsForRestoredPages: vi.fn(),
  ensureBrowserClientHostOnRuntimeContact: vi.fn()
}))
vi.mock('@/runtime/client-hosted-browser-close-intent-replay', () => ({
  replayClientHostedBrowserCloseIntents: vi.fn()
}))

const environment: PublicKnownRuntimeEnvironment = {
  id: 'paired',
  name: 'Paired',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: ''
}
const status: RuntimeStatus = {
  runtimeId: 'runtime-a',
  rendererGraphEpoch: 0,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0
}
const installed: SkillDiscoveryResult = {
  skills: [
    {
      id: 'skill',
      name: 'example',
      description: null,
      providers: [],
      sourceKind: 'home',
      sourceLabel: 'Home',
      rootPath: '/skills',
      directoryPath: '/skills/example',
      skillFilePath: '/skills/example/SKILL.md',
      installed: true,
      updatedAt: null
    }
  ],
  sources: [],
  scannedAt: 1
}
const absent: SkillDiscoveryResult = { skills: [], sources: [], scannedAt: 2 }
const initialState = useAppStore.getInitialState()

function snapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId: environment.id,
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    verification: 'verified',
    transport: 'ready',
    status,
    ...patch
  }
}

function deferred() {
  let resolve!: (value: SkillDiscoveryResult) => void
  const promise = new Promise<SkillDiscoveryResult>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function useSkill() {
  return useInstalledAgentSkill('example')
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform: 'linux' }) } }
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: environment.id }
  })
  useAppStore.getState().setRuntimeEnvironments([environment])
})

afterEach(() => {
  cleanup()
  resetSkillDiscoveryCacheForTests()
  rpc.mockReset()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

it.each([
  ['pending', 'snapshot'],
  ['completed', 'snapshot'],
  ['pending', 'checking'],
  ['completed', 'checking'],
  ['pending', 'legacy'],
  ['completed', 'legacy']
] as const)('shares a %s startup scan after the first %s status', async (phase, source) => {
  if (source === 'checking') {
    useAppStore
      .getState()
      .applyRuntimeHostStatusSnapshot(
        snapshot(1, { status: null, verification: 'checking', transport: 'connecting' })
      )
  }
  const scan = deferred()
  rpc.mockReturnValue(scan.promise)
  const renders: boolean[] = []
  const first = renderHook(() => {
    const skill = useSkill()
    renders.push(skill.settled)
    return skill
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'paired' },
    'skills.discover',
    expect.objectContaining({ names: ['example'] }),
    { timeoutMs: 15_000 }
  )
  if (phase === 'completed') {
    await act(async () => scan.resolve(installed))
    expect(first.result.current.installed).toBe(true)
  }
  renders.length = 0
  act(() => {
    if (source === 'legacy') {
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, { status, checkedAt: 2 })
    } else {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(2))
    }
  })
  expect(first.result.current.settled).toBe(phase === 'completed')
  if (phase === 'completed') {
    expect(renders).not.toContain(false)
  }
  const later = renderHook(useSkill)
  expect(later.result.current.settled).toBe(phase === 'completed')
  expect(rpc).toHaveBeenCalledTimes(1)
  if (phase === 'pending') {
    await act(async () => scan.resolve(installed))
  }
  expect(first.result.current.installed).toBe(true)
  expect(later.result.current.installed).toBe(true)
  const cachedReader = renderHook(useSkill)
  expect(cachedReader.result.current.installed).toBe(true)
  expect(cachedReader.result.current.settled).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(1)
})

it.each([
  ['pending', 'runtime'],
  ['completed', 'runtime'],
  ['pending', 'pairing'],
  ['completed', 'pairing'],
  ['pending', 'clear'],
  ['completed', 'clear'],
  ['pending', 'retirement'],
  ['completed', 'retirement']
] as const)('invalidates a %s scan on %s replacement', async (phase, replacement) => {
  useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1))
  const old = deferred()
  const fresh = deferred()
  rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const first = renderHook(useSkill)
  expect(rpc).toHaveBeenCalledTimes(1)
  if (phase === 'completed') {
    await act(async () => old.resolve(installed))
    expect(first.result.current.installed).toBe(true)
  }
  act(() => {
    if (replacement === 'pairing') {
      useAppStore.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
    } else if (replacement === 'clear') {
      useAppStore.getState().clearRuntimeEnvironmentStatus(environment.id)
    } else {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(
          replacement === 'runtime'
            ? snapshot(2, { status: { ...status, runtimeId: 'runtime-b' } })
            : snapshot(2, { verification: 'blocked', retired: true, transport: 'disconnected' })
        )
    }
  })
  expect(first.result.current.settled).toBe(false)
  expect(first.result.current.installed).toBe(false)
  expect(rpc).toHaveBeenCalledTimes(2)
  await act(async () => fresh.resolve(absent))
  expect(first.result.current.settled).toBe(true)
  if (phase === 'pending') {
    await act(async () => old.resolve(installed))
  }
  expect(first.result.current.installed).toBe(false)
  const later = renderHook(useSkill)
  expect(later.result.current.settled).toBe(true)
  expect(later.result.current.installed).toBe(false)
  expect(rpc).toHaveBeenCalledTimes(2)
})

it('retires discovery even before a status entry exists', async () => {
  const old = deferred()
  const fresh = deferred()
  rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const first = renderHook(useSkill)
  expect(rpc).toHaveBeenCalledTimes(1)
  act(() => useAppStore.getState().clearRuntimeEnvironmentStatus(environment.id))
  expect(rpc).toHaveBeenCalledTimes(2)
  await act(async () => old.resolve(installed))
  expect(first.result.current.settled).toBe(false)
  await act(async () => fresh.resolve(absent))
  expect(first.result.current.settled).toBe(true)
  expect(first.result.current.installed).toBe(false)
})

it('preserves a same-runtime transport recovery scan but fences legacy unreachable recovery', async () => {
  useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1))
  const scan = deferred()
  rpc.mockReturnValueOnce(scan.promise).mockResolvedValueOnce(absent)
  const first = renderHook(useSkill)
  await act(async () => scan.resolve(installed))
  expect(first.result.current.installed).toBe(true)
  act(() => {
    useAppStore
      .getState()
      .applyRuntimeHostStatusSnapshot(snapshot(2, { verification: 'unavailable' }))
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(3))
  })
  expect(first.result.current.installed).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(1)
  first.unmount()

  useAppStore.getState().clearRuntimeEnvironmentStatus(environment.id)
  useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, { status: null, checkedAt: 4 })
  const legacy = deferred()
  rpc.mockReturnValueOnce(legacy.promise)
  const recovered = renderHook(useSkill)
  await act(async () => {
    await Promise.resolve()
  })
  expect(recovered.result.current.settled).toBe(true)
  act(() => {
    useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, { status, checkedAt: 5 })
  })
  expect(recovered.result.current.settled).toBe(false)
  expect(rpc).toHaveBeenCalledTimes(3)
  await act(async () => legacy.resolve(installed))
  expect(recovered.result.current.installed).toBe(true)
})
