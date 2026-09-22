// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useAppStore } from '@/store'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { usePluginTaskItemWorkspaceSeed } from './workspace-seed'

const SELECTED = { pluginKey: 'nssf.azure-boards', sourceId: 'boards' }

const ITEM: PluginTaskItem = {
  id: 'item-1',
  key: 'BOARD-7',
  title: 'Ship the source bar',
  state: { name: 'In Progress', category: 'in-progress' },
  assignee: null,
  url: 'https://dev.azure.com/contoso/proj/_workitems/edit/7',
  updatedAt: null,
  scopeId: null
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function seed(item: PluginTaskItem): ReturnType<typeof vi.fn> {
  const openModal = vi.fn()
  useAppStore.setState({ openModal, selectedPluginTaskSource: SELECTED })
  const { result } = renderHook(() => usePluginTaskItemWorkspaceSeed())
  result.current(item)
  return openModal
}

describe('contributed task item workspace seed', () => {
  it('opens the shared composer with a name seeded from the clicked item', () => {
    expect(seed(ITEM)).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        prefilledName: expect.stringContaining('board-7'),
        telemetrySource: 'sidebar'
      })
    )
  })

  it('attaches the clicked item as a linked work item carrying its source identity', () => {
    expect(seed(ITEM)).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        linkedWorkItem: {
          provider: 'plugin',
          type: 'issue',
          number: 0,
          title: 'BOARD-7 Ship the source bar',
          url: 'https://dev.azure.com/contoso/proj/_workitems/edit/7',
          pluginKey: 'nssf.azure-boards',
          sourceId: 'boards'
        }
      })
    )
  })

  it('still opens the composer, unlinked, for an item the source gave no url', () => {
    const openModal = seed({ ...ITEM, url: null })
    expect(openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.not.objectContaining({ linkedWorkItem: expect.anything() })
    )
  })
})
