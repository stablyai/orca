import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'

type ButtonCapture = {
  label: string
  ariaLabel?: string
  dataContextualTourTarget?: string
  size?: string
  onClick?: () => unknown
  disabled?: boolean
}

type MenuItemCapture = {
  label: string
  dataContextualTourTarget?: string
  onSelect?: () => unknown
  disabled?: boolean
}

const mocks = vi.hoisted(() => ({
  buttons: [] as ButtonCapture[],
  menuItems: [] as MenuItemCapture[],
  state: {
    openModal: vi.fn(),
    repos: [] as Repo[],
    groupBy: 'repo' as 'repo' | 'status',
    recordFeatureInteraction: vi.fn()
  }
}))

function textContent(node: ReactModule.ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('')
  }
  if (typeof node === 'object' && 'props' in node) {
    return textContent((node as { props?: { children?: ReactModule.ReactNode } }).props?.children)
  }
  return ''
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state,
      setState: (next: Partial<typeof mocks.state>) => {
        Object.assign(mocks.state, next)
      }
    }
  )
  return { useAppStore }
})

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    size,
    ...props
  }: {
    children: ReactModule.ReactNode
    onClick?: () => unknown
    disabled?: boolean
    size?: string
    'aria-label'?: string
    'data-contextual-tour-target'?: string
  }) => {
    mocks.buttons.push({
      label: textContent(children),
      ariaLabel: props['aria-label'],
      dataContextualTourTarget: props['data-contextual-tour-target'],
      size,
      onClick,
      disabled
    })
    return (
      <button
        data-contextual-tour-target={props['data-contextual-tour-target']}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    )
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    ...props
  }: {
    children: ReactModule.ReactNode
    onSelect?: () => unknown
    disabled?: boolean
    'data-contextual-tour-target'?: string
  }) => {
    mocks.menuItems.push({
      label: textContent(children),
      dataContextualTourTarget: props['data-contextual-tour-target'],
      onSelect,
      disabled
    })
    return (
      <button disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    )
  }
}))

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({
  default: () => <div data-testid="workspace-options-menu" />
}))

vi.mock('./WorkspaceKanbanDrawer', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="workspace-board" /> : null)
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘N'
}))

function findButton(predicate: (entry: ButtonCapture) => boolean): ButtonCapture | undefined {
  return mocks.buttons.find(predicate)
}

function findMenuItem(predicate: (entry: MenuItemCapture) => boolean): MenuItemCapture | undefined {
  return mocks.menuItems.find(predicate)
}

describe('SidebarHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buttons = []
    mocks.menuItems = []
    mocks.state.repos = []
    mocks.state.groupBy = 'repo'
  })

  async function render(): Promise<string> {
    const { default: SidebarHeader } = await import('./SidebarHeader')
    return renderToStaticMarkup(<SidebarHeader />)
  }

  it('renders an enabled Add to Orca menu with zero repos and routes local folder to add-repo', async () => {
    await render()

    const addToOrca = findButton((b) => b.ariaLabel === 'Add to Orca')
    expect(addToOrca).toBeDefined()
    expect(addToOrca?.disabled).toBeFalsy()

    const openLocalFolder = findMenuItem((b) => b.label.includes('Open local folder'))
    expect(openLocalFolder).toBeDefined()

    openLocalFolder?.onSelect?.()
    expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', { autoBrowse: true })
  })

  it('keeps New worktree disabled with zero repos inside the Add menu', async () => {
    await render()

    const newWorkspace = findMenuItem((b) => b.label.includes('New worktree'))
    expect(newWorkspace?.disabled).toBe(true)

    newWorkspace?.onSelect?.()
    expect(mocks.state.openModal).not.toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.anything()
    )
  })

  it('anchors the workspace creation tour to the visible Add trigger when a worktree can be created', async () => {
    mocks.state.repos = [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]

    await render()

    const addToOrca = findButton((b) => b.ariaLabel === 'Add to Orca')
    expect(addToOrca?.dataContextualTourTarget).toBe('workspace-create-control')

    const newWorkspace = findMenuItem((b) => b.label.includes('New worktree'))
    // Why: closed dropdown items are not reliable tour anchors; the visible
    // trigger stays measurable while the handoff remains on this menu action.
    expect(newWorkspace?.dataContextualTourTarget).toBeUndefined()
  })

  it('shows the compact visible Add label under repo grouping', async () => {
    mocks.state.groupBy = 'repo'
    await render()

    const addToOrca = findButton((b) => b.ariaLabel === 'Add to Orca')
    expect(addToOrca?.label).toContain('Add')
    expect(addToOrca?.size).toBe('xs')
  })

  it('renders an icon-only Add to Orca trigger under non-repo grouping', async () => {
    mocks.state.groupBy = 'status'
    await render()

    const addToOrca = findButton((b) => b.ariaLabel === 'Add to Orca')
    // Icon-only: no visible text label, sized to match neighboring controls.
    expect(addToOrca?.label).toBe('')
    expect(addToOrca?.size).toBe('icon-xs')

    findMenuItem((b) => b.label.includes('Clone from GitHub'))?.onSelect?.()
    expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', { initialStep: 'clone' })
  })

  it('still renders the workspace board and Add menu controls', async () => {
    await render()

    expect(findButton((b) => b.ariaLabel === 'Workspace board')).toBeDefined()
    expect(findButton((b) => b.ariaLabel === 'Add to Orca')).toBeDefined()
    expect(findMenuItem((b) => b.label.includes('Remote (SSH) project'))).toBeDefined()
  })

  it('does not toggle the workspace board path when Add project is selected after opening the board', async () => {
    await render()

    const workspaceBoard = findButton((b) => b.ariaLabel === 'Workspace board')
    const remoteProject = findMenuItem((b) => b.label.includes('Remote (SSH) project'))

    workspaceBoard?.onClick?.()
    expect(mocks.state.recordFeatureInteraction).toHaveBeenCalledTimes(1)
    expect(mocks.state.recordFeatureInteraction).toHaveBeenCalledWith('workspace-board')

    remoteProject?.onSelect?.()

    expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', { initialStep: 'remote' })
    expect(mocks.state.recordFeatureInteraction).toHaveBeenCalledTimes(1)
  })
})
