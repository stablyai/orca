import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
const store = vi.hoisted(() => ({
  subscribe: vi.fn(),
  getState: vi.fn()
}))
vi.mock('@/store/index', () => ({ useAppStore: store }))
vi.mock('../local-sessions/local-structured-chats', () => ({
  localStructuredChatsInUse: async () => false
}))
vi.mock('../agent-catalogs/host-structured-agents', () => ({
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('../../hosts/capabilities/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import { resetHostModelCatalogSnapshotsForTests } from './host-model-catalog-snapshots'

it('switching PowerShell to WSL invalidates a fresh native list and its in-flight request', async () => {
  resetHostModelCatalogSnapshotsForTests()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription only reads these fields; state transport is the external port.
  const previous = {
    settings: { terminalWindowsShell: 'powershell.exe', terminalWindowsWslDistro: 'Ubuntu' },
    runtimeStatusByEnvironmentId: new Map(),
    removedRuntimeEnvironmentIds: new Set()
  } as unknown as AppState
  store.getState.mockReturnValue(previous)
  const cleanup = installHostModelCatalogSnapshotsSync()
  const change = store.subscribe.mock.calls[0][0]
  const native = {
    origin: 'probe',
    fetchedAt: 0,
    models: [{ id: 'native-model', label: 'Native', isDefault: false, efforts: [] }]
  } as const
  const guest = {
    ...native,
    models: [{ id: 'ubuntu-model', label: 'Ubuntu', isDefault: false, efforts: [] }]
  }
  const late = Promise.withResolvers<unknown>()
  const request = vi
    .fn()
    .mockResolvedValueOnce(native)
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce(guest)
  const scope = {
    target: { kind: 'local' } as const,
    agent: 'antigravity',
    sourceKey: 'cli-shell',
    request
  }
  const owner = hostModelMenuCatalog(scope)
  const stop = owner.subscribe(() => {})
  await owner.read(true)
  const pending = owner.read()
  await Promise.resolve()
  const successor = {
    ...previous,
    settings: { ...previous.settings, terminalWindowsShell: 'wsl.exe' }
  }
  store.getState.mockReturnValue(successor)
  change(successor, previous)
  expect(await owner.read(true)).toMatchObject({ models: [{ id: 'ubuntu-model' }] })
  late.resolve(native)
  await pending
  expect(owner.snapshot.answer).toMatchObject({ models: [{ id: 'ubuntu-model' }] })
  expect(request).toHaveBeenCalledTimes(3)
  stop()
  cleanup()
})
