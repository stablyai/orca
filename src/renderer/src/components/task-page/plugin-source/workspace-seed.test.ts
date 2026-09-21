// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useAppStore } from '@/store'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { usePluginTaskItemWorkspaceSeed } from './workspace-seed'

const ITEM: PluginTaskItem = {
  id: 'item-1',
  key: 'BOARD-7',
  title: 'Ship the source bar',
  state: { name: 'In Progress', category: 'in-progress' },
  assignee: null,
  url: null,
  updatedAt: null,
  scopeId: null
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('contributed task item workspace seed', () => {
  it('opens the shared composer with a name seeded from the clicked item', () => {
    const openModal = vi.fn()
    useAppStore.setState({ openModal })

    const { result } = renderHook(() => usePluginTaskItemWorkspaceSeed())
    result.current(ITEM)

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      prefilledName: expect.stringContaining('board-7'),
      telemetrySource: 'sidebar'
    })
  })
})
