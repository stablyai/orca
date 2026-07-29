import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeDeveloperMenu } from './WorktreeDeveloperMenu'

type MenuItemProps = {
  children?: ReactNode
  onSelect?: () => void
}

const menuItems = vi.hoisted(() => ({ values: [] as MenuItemProps[] }))
const requestManualPark = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuItem: (props: MenuItemProps) => {
      menuItems.values.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    }
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/manual-terminal-worktree-parking', () => ({
  requestManualTerminalWorktreePark: requestManualPark
}))

describe('WorktreeDeveloperMenu', () => {
  beforeEach(() => {
    menuItems.values = []
    requestManualPark.mockReset()
  })

  it('shows the developer submenu with the parking action', () => {
    const markup = renderToStaticMarkup(
      <WorktreeDeveloperMenu worktreeId="worktree-1" disabled={false} />
    )

    expect(markup).toContain('Developer')
    expect(markup).toContain('Park terminal')
    expect(markup).toContain('lucide-code-xml')
    expect(markup).toContain('lucide-square-parking')
  })

  it('requests parking for the context worktree', () => {
    renderToStaticMarkup(<WorktreeDeveloperMenu worktreeId="worktree-1" disabled={false} />)

    menuItems.values[0]?.onSelect?.()

    expect(requestManualPark).toHaveBeenCalledWith('worktree-1')
  })
})
