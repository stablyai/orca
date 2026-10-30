// @vitest-environment happy-dom
import { createElement, Suspense, startTransition, useLayoutEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { exerciseAgentPickerFreshness } from './agent-launch-picker-freshness-test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer
} from '../../../../shared/agent-launch-picker-rows'
import * as picker from '../../../../shared/agent-launch-picker'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import { agentPickerAcquisitionDiagnostics } from './agent-launch-picker-acquisition'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const mocks = vi.hoisted(() => ({ settings: vi.fn(), rpc: vi.fn(), session: vi.fn() }))
vi.mock('../settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: mocks.settings
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ settings: { agentDefaultArgs: { codex: '--desktop-only' } } }),
    { getState: () => ({}) }
  )
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: () => ({ executionHostId: 'local' }),
  workspaceKindForWorktreeId: () => 'git-worktree'
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: (host: string) =>
    host.startsWith('runtime:')
      ? { kind: 'environment', environmentId: host.slice(8) }
      : host === 'local'
        ? { kind: 'local' }
        : null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.session
}))

function model(
  host = 'alpha',
  agents: picker.AgentPickerEntry['agent'][] = ['codex']
): Extract<NewTabAgentMenuModel, { state: 'settled' }> {
  return {
    state: 'settled',
    rows: agents.map((agent) => ({ agent, kind: 'chat', executionHostId: `runtime:${host}` })),
    detection: {
      detectedIds: agents,
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => agents
    },
    pickerContext: {
      workspace: { kind: 'git-worktree', worktreeId: 'wt' },
      executionHostId: `runtime:${host}`,
      pairingRevision: 7,
      runtimeId: `process-${host}`,
      settings: null,
      key: host
    }
  }
}
const catalog: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    {
      id: 'host-model',
      label: 'Host model',
      isDefault: true,
      efforts: [{ value: 'low', label: 'Low' }]
    }
  ]
}
beforeEach(() => {
  mocks.settings.mockReset().mockResolvedValue(
    projectAgentLaunchSettings({
      agentPermissionDefault: 'ask',
      agentDefaultArgs: { codex: '--host-only' }
    })
  )
  mocks.rpc.mockReset()
  mocks.session
    .mockReset()
    .mockImplementation(async (_target, method) =>
      method === 'agentSession.modelCatalog'
        ? catalog
        : { seedOptions: { model: 'host-model', effort: 'low', permissionMode: 'full-access' } }
    )
})
afterEach(cleanup)

it('revalidates completed host Chat defaults behind held siblings through the actual producer, resource and panel', async () => {
  await exerciseAgentPickerFreshness({
    menu: model('source-freshness', ['claude']),
    session: mocks.session,
    catalog
  })
})

it('publishes only committed selection to physical catalog admission after a suspended render', async () => {
  const menu = model('committed-priority', ['codex', 'claude', 'gemini', 'cursor', 'amp'])
  const settings = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
  mocks.settings.mockReturnValue(settings.promise)
  const reads: {
    method: string
    agent: picker.AgentPickerEntry['agent']
    resolve: (value: unknown) => void
  }[] = []
  mocks.session.mockImplementation((_target, method, params) => {
    const read = Promise.withResolvers<unknown>()
    reads.push({ method, agent: params.agent, resolve: read.resolve })
    return read.promise
  })
  const suspended = Promise.withResolvers<void>()
  const rendered = vi.fn()
  const committed = vi.fn()
  type Selection = { selected: picker.AgentPickerEntry['agent']; suspend: boolean }
  function Inventory({ selected, suspend }: Selection) {
    const entries = useAgentLaunchPickerInventory('wt', menu, true, selected)
    rendered(selected, suspend)
    useLayoutEffect(() => {
      committed(selected)
    }, [selected])
    if (suspend) {
      throw suspended.promise
    }
    return createElement(
      'div',
      null,
      `${selected}:${entries[0]?.defaultsPending ? 'unknown' : 'known'}`
    )
  }
  function Menu() {
    const [selection, setSelection] = useState<Selection>({ selected: 'claude', suspend: false })
    return createElement(
      'div',
      null,
      createElement(
        'button',
        {
          onClick: () => startTransition(() => setSelection({ selected: 'amp', suspend: true }))
        },
        'Speculate'
      ),
      createElement(
        'button',
        {
          onClick: () => setSelection({ selected: 'amp', suspend: false })
        },
        'Commit'
      ),
      createElement(Suspense, { fallback: 'Waiting' }, createElement(Inventory, selection))
    )
  }
  const view = render(createElement(Menu))
  const catalogs = () => reads.filter((read) => read.method === 'agentSession.modelCatalog')
  const stats = () =>
    agentPickerAcquisitionDiagnostics().filter((s) => s.key.includes('committed-priority'))
  try {
    expect(catalogs().map((read) => read.agent)).toEqual(['claude', 'codex'])
    expect(stats()).toMatchObject([{ observers: 1, catalog: 2, support: 2, settings: 1 }])
    fireEvent.click(view.getByText('Speculate'))
    expect(rendered).toHaveBeenCalledWith('amp', true)
    expect(committed.mock.calls).toEqual([['claude']])
    expect(view.getByText('claude:unknown')).toBeTruthy()
    await act(async () => catalogs()[0].resolve(catalog))
    expect(catalogs().map((read) => read.agent)).toEqual(['claude', 'codex', 'gemini'])
    expect(committed.mock.calls).toEqual([['claude']])
    fireEvent.click(view.getByText('Commit'))
    expect(committed.mock.calls).toEqual([['claude'], ['amp']])
    expect(catalogs()).toHaveLength(3)
    await act(async () => catalogs()[1].resolve(catalog))
    expect(catalogs().map((read) => read.agent)).toEqual(['claude', 'codex', 'gemini', 'amp'])
    expect(stats()).toMatchObject([{ observers: 1, catalog: 2, support: 2, settings: 1 }])
    expect(mocks.settings).toHaveBeenCalledTimes(1)
    await act(async () =>
      settings.resolve(projectAgentLaunchSettings({ agentPermissionDefault: 'ask' }))
    )
    expect(view.getByText('amp:known')).toBeTruthy()
    expect(stats()).toMatchObject([{ observers: 1, catalog: 2, support: 2, settings: 0 }])
  } finally {
    view.unmount()
    expect(stats()).toMatchObject([{ observers: 0 }])
    await act(async () => {
      settings.resolve(projectAgentLaunchSettings({}))
      suspended.resolve()
      for (const read of reads) {
        read.resolve(read.method === 'agentSession.modelCatalog' ? catalog : {})
      }
    })
    expect(stats()).toEqual([])
  }
  expect(catalogs().map((read) => read.agent)).toEqual(['claude', 'codex', 'gemini', 'amp'])
  process.stdout.write(
    `${JSON.stringify({
      metric: 'committed-priority',
      suspendedRenderReachedHook: rendered.mock.calls.some(
        ([agent, suspend]) => agent === 'amp' && suspend
      ),
      committed: committed.mock.calls.map(([agent]) => agent),
      catalogStarts: catalogs().map((read) => read.agent),
      supportStarts: reads.filter((read) => read.method === 'agentSession.createSupport').length,
      settingsStarts: mocks.settings.mock.calls.length,
      retainedOwnersAfterSettlement: stats().length
    })}\n`
  )
})

it('reads host Arguments and remembered chat choices without leaking desktop defaults or refetching for selection', async () => {
  const menu = model()
  const hook = renderHook(
    ({ selected }: { selected?: 'codex' }) =>
      useAgentLaunchPickerInventory('wt', menu, true, selected),
    { initialProps: {} }
  )
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: true,
    terminal: {},
    structured: {}
  })
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    arguments: '--host-only',
    terminal: { permissionMode: 'ask' },
    structured: { model: 'host-model', options: { effort: 'low' }, permissionMode: 'full-access' },
    catalog
  })
  expect(mocks.settings).toHaveBeenCalledWith(
    { environmentId: 'alpha', pairingRevision: 7, runtimeId: 'process-alpha' },
    expect.any(AbortSignal)
  )
  hook.rerender({ selected: 'codex' })
  expect(mocks.settings).toHaveBeenCalledTimes(1)
  expect(mocks.session).toHaveBeenCalledTimes(2)
  expect(
    mocks.session.mock.calls.every(
      (call) => call[0].environmentId === 'alpha' && call[2].worktree === 'id:wt'
    )
  ).toBe(true)
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('uses existing legacy settings and a missing optional seed on an older paired host', async () => {
  mocks.settings.mockResolvedValue(null)
  mocks.rpc.mockResolvedValue({
    settings: { agentDefaultArgs: { codex: '--sandbox workspace-write' } }
  })
  mocks.session.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog' ? catalog : { supported: true }
  )
  const hook = renderHook(() => useAgentLaunchPickerInventory('wt', model(), true))
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    arguments: '--sandbox workspace-write',
    structured: { options: {} }
  })
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'alpha' },
    'settings.get',
    undefined,
    expect.objectContaining({
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'process-alpha'
    })
  )
})

it('bounds open-time catalog hydration to two agents and discards responses from the previous host', async () => {
  const old = Promise.withResolvers<AgentSessionModelCatalogResult>()
  mocks.session.mockImplementation((_target, method) =>
    method === 'agentSession.modelCatalog' ? old.promise : Promise.resolve({ supported: true })
  )
  const hook = renderHook(({ menu }) => useAgentLaunchPickerInventory('wt', menu, true), {
    initialProps: { menu: model('alpha', ['codex', 'claude', 'gemini']) }
  })
  await act(async () => {})
  const catalogs = () =>
    mocks.session.mock.calls.filter((call) => call[1] === 'agentSession.modelCatalog')
  expect(catalogs()).toHaveLength(2)
  mocks.session.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog' ? catalog : { supported: true }
  )
  hook.rerender({ menu: model('beta') })
  await act(async () => {})
  expect(mocks.settings.mock.calls[0][1].aborted).toBe(false)
  await act(async () => old.resolve({ ...catalog, fetchedAt: 2 }))
  expect(catalogs()).toHaveLength(3)
  expect(hook.result.current).toHaveLength(1)
  expect(hook.result.current[0].catalog).toEqual(catalog)
  expect(hook.result.current[0].rows[0].executionHostId).toBe('runtime:beta')
})

it.each(['slow', 'failed'] as const)(
  'publishes known terminal defaults independently of %s optional catalog/support reads',
  async (kind) => {
    const listing = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.session.mockImplementation((_target, method) =>
      method === 'agentSession.modelCatalog'
        ? listing.promise
        : kind === 'failed'
          ? Promise.reject(new Error('unavailable'))
          : Promise.resolve({ seedOptions: { model: 'host-model', permissionMode: 'ask' } })
    )
    const hook = renderHook(() => useAgentLaunchPickerInventory('wt', model(), true))
    await act(async () => {})
    expect(hook.result.current[0]).toMatchObject({
      defaultsPending: false,
      structuredDefaultsPending: kind === 'failed',
      arguments: '--host-only',
      terminal: { permissionMode: 'ask' },
      catalog: { origin: 'unknown' }
    })
    if (kind === 'slow') {
      expect(hook.result.current[0].structured.model).toBe('host-model')
    }
    await act(async () => listing.resolve(catalog))
    expect(hook.result.current[0].defaultsPending).toBe(false)
  }
)

it('retains legacy remembered values when createSupport does not supply optional seeds', async () => {
  mocks.settings.mockResolvedValue(null)
  mocks.rpc.mockResolvedValue({
    settings: {
      agentDefaultArgs: { codex: '--host-only' },
      nativeChatSessionOptions: {
        codex: { model: 'host-private', valuesByModel: { 'host-private': { effort: 'low' } } }
      },
      nativeChatPermissionMode: 'full-access'
    }
  })
  mocks.session.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog' ? catalog : { supported: true }
  )
  const hook = renderHook(() => useAgentLaunchPickerInventory('wt', model(), true))
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    structured: { model: 'host-private', options: { effort: 'low' }, permissionMode: 'full-access' }
  })
})

it('keeps Chat default controls pending until their independent seed read settles, even after catalog publication', async () => {
  const support = Promise.withResolvers<{ seedOptions?: Record<string, string> }>()
  mocks.session.mockImplementation((_target, method) =>
    method === 'agentSession.modelCatalog' ? Promise.resolve(catalog) : support.promise
  )
  const hook = renderHook(() => useAgentLaunchPickerInventory('wt', model(), true))
  await act(async () => {})
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    structuredDefaultsPending: true,
    catalog
  })
  expect(hook.result.current[0].terminal.permissionMode).toBe('ask')
  await act(async () =>
    support.resolve({ seedOptions: { model: 'remembered', permissionMode: 'ask' } })
  )
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    structuredDefaultsPending: false,
    structured: { model: 'remembered', permissionMode: 'ask' }
  })
})

it('acquires each host agent once per open batch at N and 10N, independently of catalog size and selection', async () => {
  const { TUI_AGENT_CONFIG } = await import('../../../../shared/tui-agent-config')
  const agents = Object.keys(TUI_AGENT_CONFIG).filter(
    (agent): agent is keyof typeof TUI_AGENT_CONFIG => Object.hasOwn(TUI_AGENT_CONFIG, agent)
  )
  const seeds = vi.spyOn(picker, 'agentPickerChoiceSeeds')
  for (const count of [3, 30]) {
    seeds.mockClear()
    mocks.settings.mockClear()
    mocks.session.mockClear()
    const menu = model()
    if (menu.state !== 'settled') {
      throw new Error('settled fixture')
    }
    menu.rows = agents
      .slice(0, count)
      .map((agent) => ({ agent, kind: 'chat', executionHostId: 'runtime:alpha' }))
    menu.detection.detectedIds = agents.slice(0, count)
    const hook = renderHook(
      ({ open, selected }) => useAgentLaunchPickerInventory('wt', menu, open, selected),
      { initialProps: { open: true, selected: agents[0] } }
    )
    await act(async () => {})
    expect(mocks.settings).toHaveBeenCalledTimes(1)
    expect(
      mocks.session.mock.calls.filter((call) => call[1] === 'agentSession.modelCatalog')
    ).toHaveLength(count)
    expect(
      mocks.session.mock.calls.filter((call) => call[1] === 'agentSession.createSupport')
    ).toHaveLength(count)
    hook.rerender({ open: true, selected: agents[1] })
    expect(mocks.session).toHaveBeenCalledTimes(2 * count)
    expect(seeds).toHaveBeenCalledTimes(2 * count)
    hook.rerender({ open: false, selected: agents[1] })
    hook.rerender({ open: true, selected: agents[1] })
    await act(async () => {})
    expect(mocks.session).toHaveBeenCalledTimes(4 * count)
    hook.unmount()
  }
  seeds.mockRestore()
})

it('updates terminal availability when detection changes while the Chat rows stay the same', async () => {
  const menu = model()
  if (menu.state !== 'settled') {
    throw new Error('settled fixture')
  }
  const initialProps: { value: Extract<NewTabAgentMenuModel, { state: 'settled' }> } = {
    value: { ...menu, detection: { ...menu.detection, detectedIds: [] } }
  }
  const hook = renderHook(
    ({ value }: { value: Extract<NewTabAgentMenuModel, { state: 'settled' }> }) =>
      useAgentLaunchPickerInventory('wt', value, true),
    { initialProps }
  )
  await act(async () => {})
  expect(hook.result.current[0].surfaces).toEqual(['chat'])
  hook.rerender({ value: menu })
  await act(async () => {})
  expect(hook.result.current[0].surfaces).toEqual(['chat', 'terminal'])
})

it.each([3, 30])(
  'shares actual unresolved reads and current listeners across %i opens and matching controllers',
  async (count) => {
    const { agentPickerAcquisitionDiagnostics } = await import('./agent-launch-picker-acquisition')
    const settings = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
    mocks.settings.mockReturnValue(settings.promise)
    const reads: {
      method: string
      resolve: (value: unknown) => void
      reject: (reason: Error) => void
    }[] = []
    mocks.session.mockImplementation((_target, method) => {
      const read = Promise.withResolvers<unknown>()
      reads.push({ method, resolve: read.resolve, reject: read.reject })
      return read.promise
    })
    const menu = model(`shared-${count}`, ['codex', 'claude', 'gemini'])
    const mount = (open = true) =>
      renderHook(({ open }) => useAgentLaunchPickerInventory('wt', menu, open), {
        initialProps: { open }
      })
    const one = mount(),
      two = mount()
    for (let i = 0; i < count; i++) {
      one.rerender({ open: false })
      two.rerender({ open: false })
      one.rerender({ open: true })
      two.rerender({ open: true })
    }
    two.unmount()
    const successor = mount()
    expect(mocks.settings).toHaveBeenCalledTimes(1)
    expect(reads).toHaveLength(4)
    const stats = () =>
      agentPickerAcquisitionDiagnostics().find((s) => s.key.includes(`shared-${count}`))!
    expect(stats()).toMatchObject({ observers: 2, settings: 1, catalog: 2, support: 2 })
    one.rerender({ open: false })
    successor.rerender({ open: false })
    expect(stats().observers).toBe(0)
    await act(async () =>
      reads.find((r) => r.method === 'agentSession.modelCatalog')!.resolve(catalog)
    )
    expect(reads).toHaveLength(4) // last-close settlement admits no next agent
    expect(stats().catalog).toBe(1)
    successor.rerender({ open: true })
    expect(reads).toHaveLength(5)
    await act(async () =>
      reads.find((r) => r.method === 'agentSession.createSupport')!.reject(new Error('unavailable'))
    )
    expect(reads).toHaveLength(6) // rejection releases the actual support slot
    await act(async () =>
      settings.resolve(
        projectAgentLaunchSettings({
          agentPermissionDefault: 'ask',
          agentDefaultArgs: { codex: '--add-dir docs' }
        })
      )
    )
    expect(successor.result.current[0]).toMatchObject({
      defaultsPending: false,
      arguments: '--add-dir docs',
      catalog
    })
    expect(mocks.settings).toHaveBeenCalledTimes(1)
    await act(async () => {
      for (const r of reads) {
        r.resolve(r.method === 'agentSession.modelCatalog' ? catalog : { supported: true })
      }
    })
    expect(stats()).toMatchObject({ settings: 0, catalog: 0, support: 0, observers: 1 })
    successor.unmount()
    expect(stats()).toBeUndefined()
    one.unmount()
  }
)

it.each([
  undefined,
  null,
  [],
  'bad',
  { agentDefaultArgs: 'bad' },
  { agentPermission: { default: 'ask', userArgs: 'bad' } }
])(
  'does not turn malformed/missing settings %j into known-empty, and recovers on a legitimate open',
  async (payload) => {
    const optional = Promise.withResolvers<unknown>()
    mocks.session.mockReturnValue(optional.promise)
    mocks.settings.mockResolvedValue(null)
    mocks.rpc.mockResolvedValue({ settings: payload })
    const menu = model(`invalid-${JSON.stringify(payload)}`)
    const hook = renderHook(({ open }) => useAgentLaunchPickerInventory('wt', menu, open), {
      initialProps: { open: true }
    })
    await act(async () => {})
    expect(hook.result.current[0].defaultsPending).toBe(true)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    hook.rerender({ open: false })
    mocks.rpc.mockResolvedValue({ settings: {} })
    hook.rerender({ open: true })
    expect(hook.result.current[0].defaultsPending).toBe(true)
    await act(async () => {})
    expect(hook.result.current[0].defaultsPending).toBe(false)
    expect(mocks.settings).toHaveBeenCalledTimes(2)
    expect(mocks.session).toHaveBeenCalledTimes(2) // optional pending work survives settings revalidation
    await act(async () => optional.resolve(undefined))
  }
)

it('revokes same-key read authority synchronously, retains failure as unknown, then accepts a late valid current answer', async () => {
  const menu = model('authority')
  const hook = renderHook(({ open }) => useAgentLaunchPickerInventory('wt', menu, open), {
    initialProps: { open: true }
  })
  await act(async () => {})
  expect(hook.result.current[0].defaultsPending).toBe(false)
  hook.rerender({ open: false })
  const next = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
  mocks.settings.mockReturnValue(next.promise)
  hook.rerender({ open: true })
  expect(hook.result.current[0].defaultsPending).toBe(true)
  hook.rerender({ open: false })
  hook.rerender({ open: true })
  expect(mocks.settings).toHaveBeenCalledTimes(2) // rejoins same pending read
  mocks.rpc.mockRejectedValue(new Error('legacy offline'))
  await act(async () => next.reject(new Error('offline')))
  expect(hook.result.current[0].defaultsPending).toBe(true)
  hook.rerender({ open: false })
  const valid = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
  mocks.settings.mockReturnValue(valid.promise)
  hook.rerender({ open: true })
  await act(async () =>
    valid.resolve(projectAgentLaunchSettings({ agentPermissionDefault: 'ask' }))
  )
  expect(hook.result.current[0]).toMatchObject({
    defaultsPending: false,
    terminal: { permissionMode: 'ask' }
  })
})

it('lets a re-paired owner progress independently of held local-style calls and fences late old publication', async () => {
  const oldSettings = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
  const oldOptional = Promise.withResolvers<unknown>()
  mocks.settings.mockReturnValueOnce(oldSettings.promise)
  mocks.session.mockReturnValueOnce(oldOptional.promise).mockReturnValueOnce(oldOptional.promise)
  const menu = model('re-pair')
  const hook = renderHook(({ menu }) => useAgentLaunchPickerInventory('wt', menu, true), {
    initialProps: { menu }
  })
  if (menu.state !== 'settled' || !menu.pickerContext) {
    throw new Error('fixture')
  }
  const successor = {
    ...menu,
    pickerContext: { ...menu.pickerContext, pairingRevision: 8, runtimeId: 'new-runtime' }
  }
  hook.rerender({ menu: successor })
  await act(async () => {})
  expect(mocks.settings).toHaveBeenCalledTimes(2)
  expect(hook.result.current[0].defaultsPending).toBe(false)
  const current = hook.result.current[0]
  await act(async () => {
    oldSettings.resolve(projectAgentLaunchSettings({ agentPermissionDefault: 'full-access' }))
    oldOptional.resolve(undefined)
  })
  expect(hook.result.current[0]).toEqual(current)
})

it.each([3, 30])(
  'shares uncancelable local catalog ownership across %i remounts and rereads after true settlement',
  async (count) => {
    const { agentPickerAcquisitionDiagnostics } = await import('./agent-launch-picker-acquisition')
    const read = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.session.mockReturnValue(read.promise)
    const menu = model(`local-${count}`, ['codex', 'claude', 'gemini'])
    if (menu.state !== 'settled' || !menu.pickerContext) {
      throw new Error('fixture')
    }
    menu.pickerContext.executionHostId = 'local'
    const mount = () => renderHook(() => useAgentLaunchPickerInventory('wt', menu, true))
    const surviving = mount()
    for (let i = 0; i < count; i++) {
      const transient = mount()
      transient.unmount()
    }
    expect(mocks.session).toHaveBeenCalledTimes(2)
    expect(mocks.settings).not.toHaveBeenCalled()
    expect(
      mocks.session.mock.calls.every(
        (call) => call[0].kind === 'local' && call[1] === 'agentSession.modelCatalog'
      )
    ).toBe(true)
    expect(
      agentPickerAcquisitionDiagnostics().find((s) => s.key.includes(`local-${count}`))
    ).toMatchObject({ observers: 1, catalog: 2, support: 0, settings: 0 })
    await act(async () => read.resolve(catalog))
    expect(mocks.session).toHaveBeenCalledTimes(3)
    expect(surviving.result.current.every((entry) => entry.catalog === catalog)).toBe(true)
    surviving.unmount()
    expect(agentPickerAcquisitionDiagnostics().some((s) => s.key.includes(`local-${count}`))).toBe(
      false
    )
    const fresh = mount()
    await act(async () => {})
    expect(mocks.session).toHaveBeenCalledTimes(6)
    fresh.unmount()
  }
)

it('updates a mounted setup from current host rows without making ordinary actions wait for unknown defaults', async () => {
  mocks.settings.mockRejectedValue(new Error('offline'))
  mocks.rpc.mockRejectedValue(new Error('offline'))
  const optional = Promise.withResolvers<void>()
  mocks.session.mockImplementation((_target, method) =>
    optional.promise.then(() => (method === 'agentSession.modelCatalog' ? catalog : {}))
  )
  const launch = vi.fn()
  let current: picker.AgentPickerEntry[] = []
  function Menu({ answer }: { answer: HostChatAnswer }) {
    const menu = model('late-offer')
    menu.rows = buildNewTabAgentMenuRows({
      settings: { experimentalNativeChat: true, nativeChatProviders: { codex: false } },
      detectedOnHost: ['codex'],
      chatAgents: ['codex'],
      hostChatAnswer: () => answer,
      chatProgram: () => 'available'
    }).map((row) => ({ ...row, executionHostId: 'runtime:late-offer' as const }))
    current = useAgentLaunchPickerInventory('wt', menu, true)
    return createElement(
      TooltipProvider,
      null,
      createElement(
        DropdownMenu,
        { defaultOpen: true, modal: false },
        createElement(DropdownMenuTrigger, null, 'New tab'),
        createElement(
          DropdownMenuContent,
          null,
          createElement(AgentLaunchPickerMenu, { entries: current, runLaunch: launch })
        )
      )
    )
  }
  const view = render(createElement(Menu, { answer: 'not-yet-known' }))
  await act(async () => {})
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )!
  fireEvent.click(configure)
  expect(document.body.textContent).toContain('Launch terminal')
  expect(document.body.textContent).not.toContain('Launch chat')
  for (const answer of ['yes', 'ssh', 'yes'] as const) {
    view.rerender(createElement(Menu, { answer }))
    await act(async () => {})
    expect(current[0].defaultSurface).toBe('terminal')
    expect(current[0].defaultsPending).toBe(true)
    expect(current[0].surfaces).toEqual(answer === 'yes' ? ['chat', 'terminal'] : ['terminal'])
    expect(document.body.textContent?.includes('Launch chat')).toBe(answer === 'yes')
    expect(document.querySelector('textarea')).toHaveProperty('disabled', true)
    expect(
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Launch terminal'
      )
    ).toHaveProperty('disabled', false)
  }
  expect(launch).not.toHaveBeenCalled()
  fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
  fireEvent.keyDown(document.querySelector('[role="menuitem"]')!, { key: 'Enter' })
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    { agent: 'codex', kind: 'cli', chat: true, executionHostId: 'runtime:late-offer' },
    undefined
  )
  view.unmount()
  await act(async () => optional.resolve())
})
