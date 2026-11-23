// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAiVaultPanelTransientState } from '../scope/ai-vault-panel-transient-state'
import { useAiVaultCollapseAll } from './ai-vault-collapse-all'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'

const projectGroups: AiVaultSessionListGroup[] = [
  { key: 'project:orca', label: 'orca', sessions: [] },
  { key: 'project:docs', label: 'docs', sessions: [] }
]

const manyGroups: AiVaultSessionListGroup[] = Array.from({ length: 600 }, (_, index) => ({
  key: `folder:${index}`,
  label: `folder ${index}`,
  sessions: []
}))

function renderPanel(groups: AiVaultSessionListGroup[]) {
  return renderHook(() => {
    const panel = useAiVaultPanelTransientState(true)
    const collapseAll = useAiVaultCollapseAll(
      groups,
      panel.collapsedGroups,
      panel.setGroupsCollapsed
    )
    return { panel, collapseAll }
  })
}

describe('useAiVaultCollapseAll', () => {
  it('collapses every group with a header, then expands them once all are collapsed', () => {
    const { result } = renderPanel(projectGroups)
    act(() => result.current.panel.toggleGroup('project:orca'))
    expect(result.current.collapseAll?.allCollapsed).toBe(false)

    act(() => result.current.collapseAll?.toggle())
    expect([...result.current.panel.collapsedGroups].sort()).toEqual([
      'project:docs',
      'project:orca'
    ])
    expect(result.current.collapseAll?.allCollapsed).toBe(true)

    act(() => result.current.collapseAll?.toggle())
    expect(result.current.panel.collapsedGroups.size).toBe(0)
  })

  it('leaves groups that are not listed collapsed when expanding all', () => {
    const { result } = renderPanel(projectGroups)
    act(() => result.current.panel.toggleGroup('project:elsewhere'))
    act(() => result.current.collapseAll?.toggle())
    act(() => result.current.collapseAll?.toggle())
    expect([...result.current.panel.collapsedGroups]).toEqual(['project:elsewhere'])
  })

  it('collapses every listed group even when they outnumber the remembered-fold cap', () => {
    const { result } = renderPanel(manyGroups)
    act(() => result.current.collapseAll?.toggle())
    expect(result.current.collapseAll?.allCollapsed).toBe(true)
  })

  it('keeps every other fold when expanding one group after folding more than the cap', () => {
    const { result } = renderPanel(manyGroups)
    act(() => result.current.collapseAll?.toggle())
    act(() => result.current.panel.setGroupsCollapsed(['folder:0'], false))
    const collapsed = result.current.panel.collapsedGroups
    expect(collapsed.has('folder:0')).toBe(false)
    expect(manyGroups.slice(1).filter((group) => !collapsed.has(group.key))).toEqual([])
  })

  it('offers no toggle for search results, which have no group headers', () => {
    const { result } = renderPanel([{ key: 'search-results', label: null, sessions: [] }])
    expect(result.current.collapseAll).toBeNull()
  })
})
