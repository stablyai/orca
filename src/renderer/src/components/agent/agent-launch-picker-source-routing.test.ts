import { agentPickerCatalogAvailability } from './agent-launch-picker-runtime'
import {
  withAgentPickerCatalogAvailability,
  agentPickerCatalogJobs
} from './agent-picker-catalog-jobs'
import {
  agentPickerModelMenu,
  agentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ discover: vi.fn(), structured: vi.fn() }))
vi.mock('@/runtime/native-chat/model-catalogs/terminal-model-discovery-client', () => ({
  discoverRuntimeTerminalModels: mocks.discover
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.structured
}))
import { agentPickerModelCatalogReads } from './agent-launch-picker-host-reads'
import { cliModelCatalogAnswer } from '@/runtime/native-chat/model-catalogs/model-menu-cli-catalog'
import {
  resetHostModelCatalogSnapshotsForTests,
  forgetHostModelCatalogSnapshots,
  recordHostModelCatalogSnapshot,
  subscribeHostModelCatalogSnapshot
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch/choices/agent-launch-profile'
import { cliResult, sourceEntry } from './agent-launch-picker-sources.test-fixture'

beforeEach(() => {
  mocks.discover.mockReset().mockResolvedValue(cliResult)
  mocks.structured.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

it('consumes legacy rows without claiming a configured default and separates fallback from verified empty', () => {
  expect(
    cliModelCatalogAnswer('antigravity', { ...cliResult, catalogOrigin: undefined })
  ).toMatchObject({
    origin: 'probe',
    listingNamesConfiguredModel: false,
    models: [
      { id: 'gemini-3.8-flash-high', isDefault: false, efforts: [] },
      { id: 'gemini-3.8-flash-medium' },
      { id: 'gemini-3.8-flash-low' },
      { id: 'claude-sonnet-4-6' }
    ]
  })
  expect(
    cliModelCatalogAnswer('antigravity', { ...cliResult, catalogOrigin: 'spec' })
  ).toBeUndefined()
  expect(
    cliModelCatalogAnswer('antigravity', { success: false, error: 'unsupported' })
  ).toBeUndefined()
  expect(cliModelCatalogAnswer('antigravity', { ...cliResult, models: [] })).toMatchObject({
    origin: 'probe',
    models: []
  })
  expect(
    cliModelCatalogAnswer('antigravity', { ...cliResult, catalogOrigin: undefined, models: [] })
  ).toBeUndefined()
})

it('uses the paired invocation eligibility and never forwards desktop command overrides', async () => {
  const target = { kind: 'environment', environmentId: 'paired-source-routing' } as const
  const cliContext = { target, worktreeId: 'folder:f', worktreePath: '/work/plain' }
  const reads = (command: string | undefined) =>
    agentPickerModelCatalogReads({
      target,
      cliContext,
      cliRuntime: true,
      nativeRuntime: true,
      settings: { agentCmdOverrides: command ? { antigravity: command } : {} },
      serverSettings: async () => ({ agentCmdOverrides: { antigravity: 'agy' } })
    })
  expect(await reads('agy-beta').catalog(sourceEntry(), false, 'cli')).toEqual({
    origin: 'unknown'
  })
  expect(mocks.discover).not.toHaveBeenCalled()
  await reads('agy').catalog(sourceEntry(), false, 'cli')
  expect(mocks.discover).toHaveBeenCalledWith({ ...cliContext, prefs: undefined }, 'antigravity')
  expect(mocks.structured).not.toHaveBeenCalled()
})

it('uses the guest CLI route, retains its last good list on failure, and never falls through remote global discovery to this Mac', async () => {
  const target = { kind: 'local' } as const
  const cliContext = {
    target,
    worktreeId: 'folder:guest',
    worktreePath: '\\\\wsl.localhost\\Ubuntu\\work'
  }
  const reads = agentPickerModelCatalogReads({
    target,
    cliContext,
    cliRuntime: true,
    nativeRuntime: false,
    settings: {}
  })
  const entry = { ...sourceEntry(), catalogRead: 'unsupported' as const }
  const answer = await reads.catalog(entry, false, 'cli')
  expect(answer).toMatchObject({
    models: [
      { id: 'gemini-3.8-flash-high' },
      { id: 'gemini-3.8-flash-medium' },
      { id: 'gemini-3.8-flash-low' },
      { id: 'claude-sonnet-4-6' }
    ]
  })
  expect(mocks.discover).toHaveBeenCalledWith({ ...cliContext, prefs: undefined }, 'antigravity')
  mocks.discover.mockResolvedValueOnce({ success: false, error: 'offline' })
  expect(await reads.catalog(entry, false, 'cli')).toEqual(answer)
  mocks.discover.mockClear()
  const remote = { kind: 'environment', environmentId: 'remote-global' } as const
  const global = agentPickerModelCatalogReads({
    target: remote,
    cliContext: { target: remote, worktreeId: undefined, worktreePath: '' },
    cliRuntime: true,
    nativeRuntime: true,
    settings: {},
    serverSettings: async () => ({})
  })
  expect(await global.catalog(entry, false, 'cli')).toBeUndefined()
  expect(mocks.discover).not.toHaveBeenCalled()
  const overridden = agentPickerModelCatalogReads({
    target,
    cliContext,
    cliRuntime: true,
    nativeRuntime: false,
    settings: { agentCmdOverrides: { antigravity: 'MODE=x agy' } }
  })
  expect(await overridden.catalog(entry, false, 'cli')).toEqual({ origin: 'unknown' })
  expect(mocks.discover).not.toHaveBeenCalled()
})

it('settles unsupported terminal source routes without leaving a listing placeholder', () => {
  const route = {
    agent: 'antigravity' as const,
    settings: {},
    executionHostId: 'ssh:host',
    hostCapabilities: null,
    projectExecutionKind: 'ssh' as const
  }
  const entry = withAgentPickerCatalogAvailability(
    { ...sourceEntry(), catalog: { origin: 'unknown' }, sourceCatalogs: undefined },
    agentPickerCatalogAvailability(null, route, 'folder:f', false)
  )
  expect(agentPickerCatalogJobs([entry])).toEqual([])
  expect(agentPickerModelMenu(entry, 'terminal')).toMatchObject({ status: 'builtin', rows: [] })
  const remote = { kind: 'environment', environmentId: 'host-global' } as const
  const global = withAgentPickerCatalogAvailability(
    { ...sourceEntry(), sourceCatalogs: undefined },
    agentPickerCatalogAvailability(
      remote,
      { ...route, projectExecutionKind: 'host' },
      undefined,
      true
    )
  )
  expect(agentPickerCatalogJobs([global])).toEqual([{ index: 0, source: 'structured' }])
  expect(agentPickerModelMenu(global, 'terminal')).toMatchObject({ status: 'builtin', rows: [] })
})

it('does not promote the legacy Config default fallback into a terminal operand', () => {
  const answer = cliModelCatalogAnswer('antigravity', {
    ...cliResult,
    catalogOrigin: undefined,
    models: [{ id: 'default', label: 'Changed or translated label' }],
    defaultModelId: 'default'
  })
  expect(answer).toBeUndefined()
  const entry = sourceEntry('terminal')
  entry.sourceCatalogs = {
    cli: { catalog: answer ?? { origin: 'unknown' }, catalogRead: 'settled', coherentCatalog: true }
  }
  expect(agentPickerModels(entry, 'terminal')).toEqual([])
  expect(
    projectAgentLaunchProfile('antigravity', {}, { target: 'terminal', choices: {}, userArgs: '' })
      .args
  ).toBe('')
})

it('publishes only changed CLI rows, independent of the clock', () => {
  const target = { kind: 'local' } as const
  const notices = vi.fn()
  const stop = subscribeHostModelCatalogSnapshot(target, 'antigravity', notices, 'cli')
  const now = vi.spyOn(Date, 'now').mockReturnValue(100)
  try {
    recordHostModelCatalogSnapshot(
      target,
      'antigravity',
      'id:x',
      cliModelCatalogAnswer('antigravity', cliResult)!,
      'cli'
    )
    notices.mockClear()
    now.mockReturnValue(200)
    recordHostModelCatalogSnapshot(
      target,
      'antigravity',
      'id:x',
      cliModelCatalogAnswer('antigravity', cliResult)!,
      'cli'
    )
    expect(notices).not.toHaveBeenCalled()
    recordHostModelCatalogSnapshot(
      target,
      'antigravity',
      'id:x',
      cliModelCatalogAnswer('antigravity', {
        ...cliResult,
        models: [{ id: 'new-model', label: 'New model' }]
      })!,
      'cli'
    )
    expect(notices).toHaveBeenCalledTimes(1)
  } finally {
    now.mockRestore()
    stop()
  }
})

it('reuses a held CLI answer on reopen until account invalidation', async () => {
  const target = { kind: 'local' } as const
  const reads = agentPickerModelCatalogReads({
    target,
    cliContext: { target, worktreeId: 'folder:reuse', worktreePath: '/work' },
    cliRuntime: true,
    nativeRuntime: true,
    settings: {}
  })
  const entry = sourceEntry()
  const stop = reads.observeCatalog(entry, () => {}, 'cli')
  const answer = await reads.catalog(entry, false, 'cli')
  stop()
  const stopReopened = reads.observeCatalog(entry, () => {}, 'cli')
  expect(await reads.catalog(entry, false, 'cli')).toEqual(answer)
  expect(mocks.discover).toHaveBeenCalledTimes(1)
  forgetHostModelCatalogSnapshots(target, ['antigravity'])
  await reads.catalog(entry, false, 'cli')
  expect(mocks.discover).toHaveBeenCalledTimes(2)
  stopReopened()
})

it('consumes explicit probe provenance even for empty lists and the literal default ID', () => {
  expect(
    cliModelCatalogAnswer('antigravity', { ...cliResult, models: [], catalogOrigin: 'probe' })
  ).toMatchObject({ origin: 'probe', models: [] })
  expect(
    cliModelCatalogAnswer('antigravity', {
      ...cliResult,
      catalogOrigin: 'probe',
      defaultModelId: 'default',
      models: [{ id: 'default', label: 'Config default' }]
    })
  ).toMatchObject({ origin: 'probe', models: [{ id: 'default' }] })
})
