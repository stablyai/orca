// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarGroupByToggle } from './SidebarGroupByToggle'
import type { WorktreeGroupBy } from './worktree-list-groups'

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
})
