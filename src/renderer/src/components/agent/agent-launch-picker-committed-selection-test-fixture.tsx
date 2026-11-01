import { createElement, Suspense, startTransition, useLayoutEffect, useState } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, vi } from 'vitest'
import {
  inventoryModel as model,
  inventoryCatalog as catalog
} from './agent-launch-picker-freshness-test-fixture'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type * as picker from '../../../../shared/agent-launch-picker'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import { agentPickerAcquisitionDiagnostics } from './agent-launch-picker-acquisition'

export async function exerciseCommittedAgentPickerSelection(mocks: {
  settings: ReturnType<typeof vi.fn>
  session: ReturnType<typeof vi.fn>
}) {
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
}
