// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarGroupByToggle, SidebarSecondaryGroupByToggle } from './SidebarGroupByToggle'
import type { WorktreeGroupBy, WorktreeGroupBySecondary } from './worktree-list/grouping/row-types'

const roots: Root[] = []

async function renderGroupByToggle(args: {
  groupBy: WorktreeGroupBy
  setGroupBy: (groupBy: WorktreeGroupBy) => void
}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(<SidebarGroupByToggle groupBy={args.groupBy} setGroupBy={args.setGroupBy} />)
  })

  return container
}

async function renderSecondaryGroupByToggle(args: {
  primaryGroupBy: WorktreeGroupBy
  groupBy: WorktreeGroupBySecondary
  setGroupBy: (groupBy: WorktreeGroupBySecondary) => void
}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <SidebarSecondaryGroupByToggle
        primaryGroupBy={args.primaryGroupBy}
        groupBy={args.groupBy}
        setGroupBy={args.setGroupBy}
      />
    )
  })

  return container
}

describe('SidebarGroupByToggle', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('commits the pointer-selected grouping mode', async () => {
    const setGroupBy = vi.fn()
    const container = await renderGroupByToggle({ groupBy: 'repo', setGroupBy })
    const noneButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'None'
    )

    await act(async () => {
      noneButton?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })

    expect(noneButton).not.toBeUndefined()
    expect(setGroupBy).toHaveBeenCalledWith('none')
  })

  it('offers every dimension except the selected primary dimension', async () => {
    const setGroupBy = vi.fn()
    const container = await renderSecondaryGroupByToggle({
      primaryGroupBy: 'repo',
      groupBy: 'none',
      setGroupBy
    })
    const buttons = [...container.querySelectorAll('button')]

    expect(buttons.map((button) => button.textContent)).toEqual(['None', 'Status', 'PR'])

    await act(async () => {
      buttons
        .find((button) => button.textContent === 'Status')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(setGroupBy).toHaveBeenCalledWith('workspace-status')
  })

  it('commits Project as the secondary grouping mode', async () => {
    const setGroupBy = vi.fn()
    const container = await renderSecondaryGroupByToggle({
      primaryGroupBy: 'workspace-status',
      groupBy: 'none',
      setGroupBy
    })
    const projectButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Project'
    )

    await act(async () => {
      projectButton?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })

    expect(projectButton).not.toBeUndefined()
    expect(setGroupBy).toHaveBeenCalledWith('repo')
  })
})
