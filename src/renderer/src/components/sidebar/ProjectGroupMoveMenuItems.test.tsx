/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import { ProjectGroupMoveMenuItems } from './ProjectGroupMoveMenuItems'
import { SidebarHostOptionsContext } from './sidebar-host-options-context'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type HostState = { runtimeEnvironments: unknown[]; sshConnectionStates: Map<string, unknown> }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: HostState) => unknown) =>
    selector({ runtimeEnvironments: [], sshConnectionStates: new Map<string, unknown>() })
}))

const hosts: ExecutionHostRegistryEntry[] = [
  { id: 'local', kind: 'local', label: 'Orca A', detail: 'This computer', health: 'local' },
  {
    id: 'runtime:orca-b',
    kind: 'runtime',
    label: 'Orca B',
    detail: 'orca-b.example',
    health: 'available'
  }
]

function group(id: string, name: string, executionHostId: string): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    executionHostId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function renderItems(
  projectGroups: ProjectGroup[],
  sidebarHosts: readonly ExecutionHostRegistryEntry[] | null = hosts
): string[] {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(
      <SidebarHostOptionsContext.Provider value={sidebarHosts}>
        <DropdownMenu open>
          <DropdownMenuTrigger>Move to group</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ProjectGroupMoveMenuItems
              projectGroups={projectGroups}
              currentGroupId={null}
              onMove={() => {}}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHostOptionsContext.Provider>
    )
  })
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )
}

describe('ProjectGroupMoveMenuItems', () => {
  it("names each group's computer when the groups come from two computers", () => {
    expect(
      renderItems([group('a', 'Group A', 'local'), group('b', 'Group B', 'runtime:orca-b')])
    ).toEqual(['Group AOrca A', 'Group BOrca B'])
  })

  it('names both computers when each has a copy of the same group id', () => {
    expect(
      renderItems([group('a', 'Group', 'local'), group('a', 'Group', 'runtime:orca-b')])
    ).toEqual(['GroupOrca A', 'GroupOrca B'])
  })

  it('lists only names outside the sidebar, where no host registry names the computers', () => {
    expect(
      renderItems([group('a', 'Group A', 'local'), group('b', 'Group B', 'runtime:orca-b')], null)
    ).toEqual(['Group A', 'Group B'])
  })

  it('lists only names when every group is on one computer', () => {
    expect(renderItems([group('a', 'Group A', 'local'), group('c', 'Group C', 'local')])).toEqual([
      'Group A',
      'Group C'
    ])
  })
})
