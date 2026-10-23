// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '../sidebar/folder-workspace-composer-submit-fixtures'
import { makeAutomation } from './automations-page-fixtures'
import { unscopedAutomationListRows } from './automation-list-row-identity'
import { useAutomationsPageStoreState } from './use-automations-page-store-state'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('automation rows that target a folder workspace', () => {
  it('find the folder workspace instead of reporting it gone', () => {
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ id: 'fw-1', name: 'App' })]
    })
    const [row] = unscopedAutomationListRows([
      makeAutomation({ workspaceMode: 'existing', workspaceId: 'folder:fw-1' })
    ])
    const { result } = renderHook(() => useAutomationsPageStoreState())

    expect(result.current.worktreeForRow(row, undefined)?.displayName).toBe('App')
  })
})
