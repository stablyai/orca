// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { HOST_LIST_ROW_LIMIT } from './bounded-host-list'
import { getDefaultSettings } from '../../../../shared/constants'

// Why 13,692: the host count from the generated ~/.ssh/config in the renderer crash this guards.
const HOST_COUNT = 13_692
const NODE_BUDGET = 3_000
const names = Array.from({ length: HOST_COUNT }, (_, i) => `node-${String(i).padStart(5, '0')}`)
const lastName = names[HOST_COUNT - 1]!

const hostOptions = names.map((name, i): SidebarHostOption => ({
  id: `ssh:ssh-${i}`,
  label: name,
  detail: '',
  kind: 'ssh',
  health: 'disconnected',
  presence: 'configured'
}))

// Why a pass-through menu: Radix only mounts sub-menu content after pointer or keyboard entry.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuItem: ({ children }: { children?: React.ReactNode }) => (
      <div role="menuitem">{children}</div>
    ),
    DropdownMenuCheckboxItem: ({ children }: { children?: React.ReactNode }) => (
      <div role="menuitemcheckbox">{children}</div>
    )
  }
})
vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions, hostScopeOptions: [] })
}))
vi.mock('../settings/use-notification-source-options', () => ({
  useNotificationSourceOptions: () => hostOptions
}))

const { SidebarHostScopeMenuSection } = await import('../sidebar/SidebarHostScopeMenuSection')
const { NotificationHostToggles } = await import('../settings/NotificationHostToggles')
const { WorkspaceDirectorySetting } = await import('../settings/WorkspaceDirectorySetting')

function nodeCount(): number {
  return document.body.getElementsByTagName('*').length
}

afterEach(() => {
  cleanup()
})

describe('host menus and settings with a 13,692-host ssh config', () => {
  it('sidebar Hosts submenu keeps a filter’s checked hosts and bounds the rest', () => {
    const lastId = hostOptions[HOST_COUNT - 1]!.id
    render(
      <SidebarHostScopeMenuSection
        hostVisibilityLabel="1 host"
        hostOptions={hostOptions}
        preserveWorkspaceBoardOpen={false}
        setWorkspaceHostScope={vi.fn()}
        visibleWorkspaceHostIds={[lastId]}
        setVisibleWorkspaceHostIds={vi.fn()}
      />
    )
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    expect(screen.getAllByRole('menuitemcheckbox').length).toBeLessThanOrEqual(
      HOST_LIST_ROW_LIMIT + 2
    )
    expect(screen.getByText(lastName)).toBeTruthy()
  })

  it('Notifications > Machines keeps muted hosts and finds the rest by search', () => {
    const lastId = hostOptions[HOST_COUNT - 1]!.id
    render(
      <NotificationHostToggles
        mutedNotificationSourceIds={[lastId]}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Machines'))
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    expect(screen.getByText(lastName)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search hosts…' }), {
      target: { value: 'node-00042' }
    })
    expect(screen.getByText('node-00042')).toBeTruthy()
  })

  it('Settings > General workspace directory "Apply to" mounts no host rows until opened', () => {
    render(
      <WorkspaceDirectorySetting settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )
    expect(nodeCount()).toBeLessThan(NODE_BUDGET)
    expect(screen.queryByText(lastName)).toBeNull()
  })
})
