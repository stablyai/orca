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
const runtimeTarget = { kind: 'environment', environmentId: environment.id } as const
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
  let reject!: (reason: Error) => void
  const promise = new Promise<SkillDiscoveryResult>((finish, fail) => {
    resolve = finish
    reject = fail
  })
  return { promise, resolve, reject }
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

it('does not repeat identity lookups or serialization on unrelated store publications', () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null }
  })
  rpc.mockReturnValue(deferred().promise)
  const catalogFind = vi.spyOn(useAppStore.getState().runtimeEnvironments, 'find')
  const stringify = vi.spyOn(JSON, 'stringify')
  const identitySerializations = () =>
    stringify.mock.calls.filter(
      ([value]) => Array.isArray(value) && value.length === 2 && value[0] === 1 && value[1] === 0
    ).length
  for (let index = 0; index < 3; index++) {
    renderHook(() => useInstalledAgentSkill('example', { runtimeTarget }))
  }
  const initialLookups = catalogFind.mock.calls.length
  const initialSerializations = identitySerializations()
  expect(initialLookups).toBeGreaterThan(0)
  expect(initialSerializations).toBeGreaterThan(0)
  expect(rpc).toHaveBeenCalledTimes(1)

  act(() => {
    for (let width = 300; width < 330; width++) {
      useAppStore.getState().setSidebarWidth(width)
    }
  })

  expect(catalogFind).toHaveBeenCalledTimes(initialLookups)
  expect(identitySerializations()).toBe(initialSerializations)
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('skips disabled identity lookups and reads the latest generation when enabled', async () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null }
  })
  rpc.mockResolvedValueOnce(installed)
  const cached = renderHook(() => useInstalledAgentSkill('example', { runtimeTarget }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(cached.result.current.installed).toBe(true)
  cached.unmount()
  rpc.mockClear()
  const catalogFind = vi.spyOn(useAppStore.getState().runtimeEnvironments, 'find')
  const { result, rerender } = renderHook(
    ({ enabled }) => useInstalledAgentSkill('example', { enabled, runtimeTarget }),
    { initialProps: { enabled: false } }
  )
  act(() => {
    useAppStore.getState().setSidebarWidth(300)
    useAppStore.getState().clearRuntimeEnvironmentStatus(environment.id)
  })
  expect(catalogFind).not.toHaveBeenCalled()
  expect(rpc).not.toHaveBeenCalled()

  rpc.mockResolvedValueOnce(absent)
  await act(async () => rerender({ enabled: true }))
  expect(catalogFind).toHaveBeenCalledTimes(1)
  expect(result.current.installed).toBe(false)
  expect(result.current.settled).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(1)
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

it.each([
  ['failed', 'startup'],
  ['pending', 'startup'],
  ['failed', 'retirement'],
  ['pending', 'retirement']
] as const)(
  'recovers a %s %s scan once contact returns, sharing the retry',
  async (phase, source) => {
    if (source === 'retirement') {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1))
      rpc.mockResolvedValueOnce(installed)
      const previous = renderHook(useSkill)
      await act(async () => {
        await Promise.resolve()
      })
      expect(previous.result.current.installed).toBe(true)
      previous.unmount()
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(
          snapshot(2, { verification: 'blocked', retired: true, transport: 'disconnected' })
        )
      rpc.mockClear()
    }
    const offline = deferred()
    const retry = deferred()
    rpc.mockReturnValueOnce(offline.promise).mockReturnValueOnce(retry.promise)
    const first = renderHook(useSkill)
    const second = renderHook(useSkill)
    expect(rpc).toHaveBeenCalledTimes(1)
    if (phase === 'failed') {
      await act(async () => offline.reject(new Error('Host disconnected')))
      expect(first.result.current.error).toBe('Host disconnected')
      expect(second.result.current.error).toBe('Host disconnected')
    }

    act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(3)))
    const later = renderHook(useSkill)
    if (phase === 'pending') {
      expect(rpc).toHaveBeenCalledTimes(1)
      await act(async () => offline.reject(new Error('Host disconnected')))
    }
    expect(rpc).toHaveBeenCalledTimes(2)
    await act(async () => retry.resolve(installed))
    for (const consumer of [first, second, later]) {
      expect(consumer.result.current.installed).toBe(true)
      expect(consumer.result.current.settled).toBe(true)
      expect(consumer.result.current.loading).toBe(false)
      expect(consumer.result.current.error).toBeNull()
    }
    expect(renderHook(useSkill).result.current.installed).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(2)
  }
)

it.each(['pending', 'completed'] as const)(
  'preserves a successful %s scan on retired-host reconnection even past cache freshness',
  async (phase) => {
    useAppStore
      .getState()
      .applyRuntimeHostStatusSnapshot(
        snapshot(1, { verification: 'blocked', retired: true, transport: 'disconnected' })
      )
    const scan = deferred()
    rpc.mockReturnValue(scan.promise)
    const first = renderHook(useSkill)
    if (phase === 'completed') {
      await act(async () => scan.resolve(absent))
    }
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_060_000)
    act(() => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(2)))
    if (phase === 'pending') {
      await act(async () => scan.resolve(absent))
    }
    expect(first.result.current.settled).toBe(true)
    expect(first.result.current.installed).toBe(false)
    expect(first.result.current.error).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  }
)

it.each(['failed', 'pending'] as const)(
  'limits a %s scan to one retry per contact epoch across consumers',
  async (phase) => {
    const offline = deferred()
    rpc.mockReturnValueOnce(offline.promise).mockRejectedValue(new Error('Scan failed'))
    const first = renderHook(useSkill)
    const second = renderHook(useSkill)
    if (phase === 'failed') {
      await act(async () => offline.reject(new Error('Host disconnected')))
    }
    await act(async () => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1)))
    if (phase === 'pending') {
      await act(async () => offline.reject(new Error('Host disconnected')))
    }
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(first.result.current.error).toBe('Scan failed')
    expect(second.result.current.error).toBe('Scan failed')
    await act(async () => useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(2)))
    expect(rpc).toHaveBeenCalledTimes(2)
    await act(async () => {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(snapshot(3, { verification: 'unavailable' }))
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(4))
    })
    expect(rpc).toHaveBeenCalledTimes(3)
  }
)

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
