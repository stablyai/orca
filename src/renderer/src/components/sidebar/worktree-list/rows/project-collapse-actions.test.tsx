// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { group, repo } from '../parity/sidebar-list-golden-factories.test-fixture'
import { ProjectCollapseMenuItems } from './project-collapse-actions'

const initial = useAppStore.getInitialState()
const outerGroup: GroupHeaderRow = {
  type: 'header',
  key: 'project-group:outer',
  count: 2,
  icon: { kind: 'project' },
  projectGroup: group('outer', 'Outer'),
  collapsedSubtree: {
    groupKeys: ['project-group:inner'],
    projects: [
      {
        key: 'repo:active',
        worktreeIds: ['selected'],
        groupKeys: ['project-group:outer', 'project-group:inner']
      },
      { key: 'repo:idle', worktreeIds: ['idle'], groupKeys: ['project-group:outer'] }
    ]
  }
}

beforeEach(() => {
  vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

function selectAction(rows: GroupHeaderRow[], name: string): void {
  const menu = render(
    <DropdownMenu defaultOpen>
      <DropdownMenuContent>
        <ProjectCollapseMenuItems getRows={() => rows} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  fireEvent.click(menu.getByRole('menuitem', { name }))
}

it('opens the selected project and its collapsed ancestors while collapsing idle projects', () => {
  useAppStore.setState({
    activeWorktreeId: 'selected',
    collapsedGroups: new Set(['project-group:outer', 'project-group:inner', 'repo:active'])
  })
  selectAction([outerGroup], 'Expand only active projects')
  expect(useAppStore.getState().collapsedGroups).toEqual(new Set(['repo:idle']))
})

it('keeps a shared project expanded when its active host is followed by an idle host', () => {
  const local: GroupHeaderRow = {
    type: 'header',
    key: 'repo:shared',
    hostId: 'local',
    count: 1,
    icon: { kind: 'project' },
    repo: repo('shared', 'Shared'),
    worktreeIds: ['local-selected']
  }
  const remote: GroupHeaderRow = {
    ...local,
    key: 'repo:shared:host:runtime:home',
    collapseKey: 'repo:shared',
    hostId: 'runtime:home',
    repo: repo('shared', 'Shared', { executionHostId: 'runtime:home' }),
    worktreeIds: ['remote-idle']
  }
  useAppStore.setState({
    activeWorktreeId: 'local-selected',
    collapsedGroups: new Set(['repo:shared'])
  })
  selectAction([local, remote], 'Expand only active projects')
  expect(useAppStore.getState().collapsedGroups).toEqual(new Set())
})

it('expands all projects and nested groups while retaining unrelated collapse keys', () => {
  useAppStore.setState({
    collapsedGroups: new Set([
      'project-group:outer',
      'project-group:inner',
      'repo:active',
      'repo:idle',
      'pinned'
    ])
  })
  selectAction([outerGroup], 'Expand all projects')
  expect(useAppStore.getState().collapsedGroups).toEqual(new Set(['pinned']))
})
