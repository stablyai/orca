import { createElement } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import { agentPickerAcquisitionDiagnostics } from './agent-launch-picker-acquisition'
import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import * as picker from '../../../../shared/agent-launch-picker'
import {
  applyNativeChatSessionOptionPicks,
  structuredLaunchSeedOptions
} from '../../../../shared/native-chat/input/native-chat-session-option-defaults'

export async function exerciseAgentPickerFreshness({
  menu,
  session,
  catalog
}: {
  menu: Extract<NewTabAgentMenuModel, { state: 'settled' }>
  session: ReturnType<typeof vi.fn>
  catalog: picker.AgentPickerEntry['catalog']
}) {
  let saved = applyNativeChatSessionOptionPicks({
    persisted: {},
    agent: 'claude',
    picks: [{ modelId: 'opus', optionId: 'effort', value: 'low' }]
  })
  const seed = () =>
    structuredLaunchSeedOptions(
      { nativeChatSessionOptions: saved, nativeChatPermissionMode: 'ask' },
      'claude'
    )
  const firstSeed = seed()
  const reads: {
    host: string
    method: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }[] = []
  session.mockImplementation((target, method) => {
    const read = Promise.withResolvers<unknown>()
    reads.push({ host: target.environmentId, method, resolve: read.resolve, reject: read.reject })
    return read.promise
  })
  const supports = () => reads.filter((r) => r.method === 'agentSession.createSupport')
  const launches = vi.fn()
  const snapshots: picker.AgentPickerEntry[] = []
  const current: { entry?: picker.AgentPickerEntry } = {}
  function Setup({ value }: { value: typeof menu }) {
    const [entry] = useAgentLaunchPickerInventory('wt', value, true)
    current.entry = entry
    snapshots.push(entry)
    return createElement(
      TooltipProvider,
      null,
      createElement(AgentLaunchSetupPanel, {
        key: entry.ownerKey,
        entry,
        onUse: (draft) => launches(picker.agentPickerLaunchInputs(draft, entry))
      })
    )
  }
  const mount = () => render(createElement(Setup, { value: menu }))
  let view = mount()
  let second: ReturnType<typeof mount> | undefined
  const search = () =>
    view.container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
  const choice = () => view.container.querySelector('[cmdk-item][data-current="true"]')?.textContent
  const effortControls = () => [
    ...view.container.querySelectorAll<HTMLButtonElement>(
      '[data-option-id="effort"] [role="radio"]'
    )
  ]
  const effort = () =>
    view.container.querySelector('[data-option-id="effort"] [data-state="on"]')?.textContent
  const launch = () => {
    fireEvent.click(
      [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Launch chat')!
    )
    expect(launches.mock.lastCall).toEqual([{}])
  }
  const stats = () =>
    agentPickerAcquisitionDiagnostics().filter((s) => s.key.includes('source-freshness'))
  try {
    await act(async () => supports()[0].resolve({ seedOptions: seed() }))
    expect(choice()).toContain('Opus')
    expect(effort()).toBe('Low')
    expect(search().disabled).toBe(false)
    expect(effortControls().length).toBeGreaterThan(0)
    expect(effortControls().every((control) => !control.disabled)).toBe(true)
    expect(current.entry?.structured).toMatchObject({
      model: seed()?.model,
      options: { effort: 'low' }
    })
    launch()
    view.unmount()
    saved = applyNativeChatSessionOptionPicks({
      persisted: saved,
      agent: 'claude',
      picks: [{ modelId: 'sonnet', optionId: 'effort', value: 'high' }]
    })
    snapshots.length = 0
    view = mount()
    await act(async () => {})
    process.stdout.write(
      `${JSON.stringify({ metric: 'source-freshness-reopen', producer: seed(), displayed: current.entry?.structured, supportStarts: supports().length, disabled: search().disabled })}\n`
    )
    expect(snapshots.every((entry) => entry.structuredDefaultsPending)).toBe(true)
    expect(search().disabled).toBe(true)
    expect(choice()).toBeUndefined()
    expect(supports()).toHaveLength(2)
    launch()
    second = mount()
    expect(supports()).toHaveLength(2)
    expect(stats()).toMatchObject([{ observers: 2, catalog: 1, support: 1 }])
    await act(async () => supports()[1].resolve({ seedOptions: seed() }))
    expect(choice()).toContain('Sonnet')
    expect(effort()).toBe('High')
    expect(search().disabled).toBe(false)
    expect(
      second.container.querySelector('[cmdk-item][data-current="true"]')?.textContent
    ).toContain('Sonnet')
    expect(current.entry?.structured).toMatchObject({
      model: seed()?.model,
      options: { effort: 'high' }
    })
    launch()
    second.unmount()
    for (const answer of ['missing', 'rejected'] as const) {
      view.unmount()
      view = mount()
      expect(search().disabled).toBe(true)
      const read = supports().at(-1)!
      await act(async () =>
        answer === 'missing' ? read.resolve({ supported: true }) : read.reject(new Error('offline'))
      )
      expect(current.entry?.structuredDefaultsPending).toBe(true)
      expect(current.entry?.structured.model).toBeUndefined()
      expect(search().disabled).toBe(true)
      expect(choice()).toBeUndefined()
      expect(effortControls().length).toBeGreaterThan(0)
      expect(effortControls().every((control) => control.disabled)).toBe(true)
      launch()
    }
    view.unmount()
    view = mount()
    const starts = supports().length
    const pendingRead = supports().at(-1)!
    view.unmount()
    view = mount()
    expect(supports()).toHaveLength(starts)
    expect(search().disabled).toBe(true)
    await act(async () => pendingRead.resolve({ seedOptions: seed() }))
    expect(effort()).toBe('High')
    view.unmount()
    view = mount()
    const oldRead = supports().at(-1)!
    if (!menu.pickerContext) {
      throw new Error('paired fixture')
    }
    view.rerender(
      createElement(Setup, {
        value: {
          ...menu,
          pickerContext: { ...menu.pickerContext, pairingRevision: 8, runtimeId: 'replacement' }
        }
      })
    )
    expect(search().disabled).toBe(true)
    expect(supports()).toHaveLength(starts + 2)
    const newRead = supports().at(-1)!
    await act(async () => newRead.resolve({ seedOptions: seed() }))
    const owner = current.entry?.ownerKey
    await act(async () => oldRead.resolve({ seedOptions: firstSeed }))
    expect(current.entry?.ownerKey).toBe(owner)
    expect(effort()).toBe('High')
    expect(choice()).toContain('Sonnet')
    launch()
  } finally {
    view.unmount()
    second?.unmount()
    await act(async () =>
      reads.forEach((read) =>
        read.resolve(read.method === 'agentSession.modelCatalog' ? catalog : {})
      )
    )
    expect(stats()).toEqual([])
  }
}
