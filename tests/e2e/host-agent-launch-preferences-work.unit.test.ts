// @vitest-environment happy-dom
import {
  rpc,
  status
} from '../../src/renderer/src/components/tab-bar/new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useNewTabAgentMenuRows } from '../../src/renderer/src/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from '../../src/renderer/src/components/agent/use-agent-launch-picker-inventory'
import * as acquisitions from '../../src/renderer/src/components/agent/agent-launch-picker-acquisition'
import * as routes from '@/lib/agent-launch-route-input'
import * as profile from '../../src/shared/agent-launch-profile'
import * as composition from '../../src/shared/tui-agent-launch-defaults'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import type { RuntimeStore } from '../../src/main/runtime/runtime-store-contract'
import { RuntimeClientSettingsController } from '../../src/main/runtime/runtime-client-settings'
import { mutateHostAgentLaunchSettings } from '../../src/renderer/src/components/settings/agent-launch-settings-transport'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../src/shared/agent-launch-runtime-capability'
import { structuredLaunchSeedOptions } from '../../src/shared/native-chat/input/native-chat-session-option-defaults'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

vi.mock('../../src/main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => {})
}))

function hostWriter() {
  const settings = createGlobalSettingsFixture({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentPermissionDefault: 'own',
    agentLaunchChoices: { claude: { model: 'host-0' } }
  })
  const write = vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
  const durable: NonNullable<RuntimeStore['runDurableMutation']> = async (mutate) => mutate().value
  const controller = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings: write,
    runDurableMutation: durable
  })
  return { settings, write, controller }
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
function mount(count: number) {
  let renders = 0
  const holders = Array.from({ length: count }, () =>
    renderHook(
      ({ open }) => {
        const menu = useNewTabAgentMenuRows('wt', open, { kind: 'runtime', environmentId: 'alpha' })
        renders++
        return useAgentLaunchPickerInventory('wt', menu, open)
      },
      { initialProps: { open: true } }
    )
  )
  return { holders, renders: () => renders }
}

it.each([20, 200])(
  'bounds actual open acquisition and host writes for %i mounted holders',
  async (count) => {
    const host = hostWriter()
    rpc.call.mockImplementation(async (_target, method, mutation) => {
      if (method === 'settings.mutateAgentLaunch') {
        return { settings: await host.controller.mutateAgentLaunch(mutation) }
      }
      if (method === 'agentSession.modelCatalog') {
        return { origin: 'probe', models: [] }
      }
      if (method === 'agentSession.createSupport') {
        return {
          supported: true,
          seedOptions: structuredLaunchSeedOptions(host.settings, 'claude')
        }
      }
      return { settings: host.controller.getAgentLaunch() }
    })
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentDefaultSurface: 'chat' },
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set('alpha', {
        ...status(),
        status: {
          ...status().status!,
          capabilities: [...(status().status!.capabilities ?? []), AGENT_LAUNCH_CHOICES_CAPABILITY]
        }
      })
    }))
    const acquire = vi.spyOn(acquisitions, 'observeAgentPickerAcquisition')
    const route = vi.spyOn(routes, 'buildAgentLaunchRouteInput')
    const project = vi.spyOn(profile, 'projectAgentLaunchProfile')
    const compose = vi.spyOn(composition, 'composeAgentLaunchProfile')
    const menu = mount(count)
    const snapshot = () => ({
      renders: menu.renders(),
      acquire: acquire.mock.calls.length,
      profiles: project.mock.calls.length,
      compositions: compose.mock.calls.length,
      routes: route.mock.calls.length,
      status: rpc.supports.mock.calls.length,
      settings: rpc.call.mock.calls.filter(([, method]) => method === 'settings.getAgentLaunch')
        .length,
      catalog: rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog')
        .length,
      support: rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.createSupport')
        .length
    })
    try {
      await settle()
      await settle()
      expect(
        menu.holders[0].result.current.find((entry) => entry.agent === 'claude')?.terminal.model
      ).toBe('host-0')
      const before = snapshot()
      expect(before.acquire).toBeLessThanOrEqual(3 * count)
      expect(before.profiles).toBeLessThanOrEqual(4 * count + 160)
      expect(before.routes).toBeLessThanOrEqual(14 * count)
      expect(before.settings).toBeLessThanOrEqual(3)
      expect(before.catalog).toBeGreaterThan(0)
      expect(before.catalog).toBeLessThanOrEqual(6)
      expect(before.support).toBeGreaterThan(0)
      expect(before.support).toBeLessThanOrEqual(6)
      const updates = [
        () =>
          useAppStore.setState((state) => ({
            settings: { ...state.settings!, terminalFontSize: 19 }
          })),
        () =>
          useAppStore.setState((state) => ({
            runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
              'beta',
              status('other')
            )
          })),
        () =>
          useAppStore.setState((state) => ({
            settings: {
              ...state.settings!,
              agentLaunchChoices: { claude: { model: 'unused-desktop' } }
            }
          }))
      ]
      for (const update of updates) {
        await act(async () => update())
        const after = snapshot()
        expect({ ...after, routes: before.routes }).toEqual(before)
      }
      expect(snapshot().routes - before.routes).toBeLessThanOrEqual(3 * count)
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha', pairingRevision: 7 },
          { type: 'launch-choices', agent: 'claude', patch: { model: 'host-next' } }
        )
      })
      await settle()
      expect(host.write).toHaveBeenCalledOnce()
      expect(host.settings.agentLaunchChoices?.claude).toEqual({ model: 'host-next' })
      expect(menu.renders()).toBeGreaterThan(before.renders)
      expect(
        menu.holders.every(
          (holder) =>
            holder.result.current.find((entry) => entry.agent === 'claude')?.terminal.model ===
            'host-next'
        )
      ).toBe(true)
      expect(snapshot().catalog - before.catalog).toBeLessThanOrEqual(6)
      expect(snapshot().profiles - before.profiles).toBeLessThanOrEqual(4 * count + 240)
      expect(snapshot().acquire - before.acquire).toBeLessThanOrEqual(2 * count)
      expect(snapshot().routes - before.routes).toBeLessThanOrEqual(11 * count)
      expect(snapshot().support - before.support).toBeLessThanOrEqual(4)
      expect(snapshot().settings - before.settings).toBeLessThanOrEqual(3)
      expect(snapshot().status - before.status).toBeLessThanOrEqual(6)
      process.stdout.write(
        `${JSON.stringify({
          contract: 'open-host-writer',
          count,
          before,
          after: snapshot(),
          writes: host.write.mock.calls.length
        })}\n`
      )
    } finally {
      menu.holders.forEach((holder) => holder.unmount())
      acquire.mockRestore()
      route.mockRestore()
      project.mockRestore()
      compose.mockRestore()
    }
  }
)

it.each([20, 200])(
  'retires %i admitted map generations after completion while a live successor finishes',
  async (count) => {
    const host = hostWriter()
    const pending: { kind: string; finish: () => void }[] = []
    let held = false
    let allowResource = true
    rpc.call.mockImplementation(async (_target, method, mutation) => {
      if (method === 'settings.mutateAgentLaunch') {
        allowResource = true
        return { settings: await host.controller.mutateAgentLaunch(mutation) }
      }
      const resource = method === 'settings.getAgentLaunch' && allowResource
      if (resource) {
        allowResource = false
      }
      if (held && !resource) {
        await new Promise<void>((resolve) => pending.push({ kind: method, finish: resolve }))
      }
      if (method === 'agentSession.modelCatalog') {
        return { origin: 'probe', models: [] }
      }
      if (method === 'agentSession.createSupport') {
        return {
          supported: true,
          seedOptions: structuredLaunchSeedOptions(host.settings, 'claude')
        }
      }
      return { settings: host.controller.getAgentLaunch() }
    })
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentDefaultSurface: 'chat' }
    }))
    const menu = mount(1)
    await settle()
    await settle()
    held = true
    for (let generation = 1; generation <= count; generation++) {
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha', pairingRevision: 7 },
          { type: 'launch-choices', agent: 'claude', patch: { model: `host-${generation}` } }
        )
      })
      await settle()
    }
    expect(host.write).toHaveBeenCalledTimes(count)
    const retained = acquisitions.agentPickerAcquisitionDiagnostics()
    expect(retained.length).toBe(count)
    expect(retained.filter((owner) => owner.observers > 0)).toHaveLength(1)
    menu.holders.forEach((holder) => holder.rerender({ open: false }))
    menu.holders.forEach((holder) => holder.unmount())
    await act(async () => replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 8 }]))
    expect(
      acquisitions.agentPickerAcquisitionDiagnostics().every((owner) => owner.observers === 0)
    ).toBe(true)
    held = false
    allowResource = true
    const successor = mount(1)
    try {
      await settle()
      await settle()
      expect(
        successor.holders[0].result.current.find((entry) => entry.agent === 'claude')?.terminal
          .model
      ).toBe(`host-${count}`)
      const admitted = rpc.call.mock.calls.length
      await act(async () => pending.forEach((work) => work.finish()))
      await settle()
      await settle()
      expect(rpc.call).toHaveBeenCalledTimes(admitted)
      expect(acquisitions.agentPickerAcquisitionDiagnostics()).toHaveLength(1)
      const completions = pending.reduce<Record<string, number>>((counts, work) => {
        counts[work.kind] = (counts[work.kind] ?? 0) + 1
        return counts
      }, {})
      expect(completions).toEqual({
        'agentSession.modelCatalog': 2 * count,
        'agentSession.createSupport': 2 * count,
        'settings.getAgentLaunch': count
      })
      process.stdout.write(
        `${JSON.stringify({
          contract: 'pending-generation-drain',
          count,
          retained: retained.length,
          completions
        })}\n`
      )
    } finally {
      successor.holders.forEach((holder) => holder.unmount())
      await settle()
    }
    expect(acquisitions.agentPickerAcquisitionDiagnostics()).toEqual([])
  }
)
