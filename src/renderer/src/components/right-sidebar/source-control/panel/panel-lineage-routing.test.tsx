// why: the panel renders through React DOM, so @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageMember } from '../../../../../../shared/lineage-discovery-types'
import { useAppStore } from '@/store'
import { useContext } from 'react'
import { AddToTowerEntryContext } from '../../lineage-members/add-to-tower-entry'

type LineageMembersStub = { members: LineageMember[]; loading: boolean; supported: boolean }

const lineage = vi.hoisted(() => {
  const keys: (string | null)[] = []
  const result: LineageMembersStub = { members: [], loading: false, supported: true }
  return { keys, result }
})

vi.mock('../../lineage-members/use-lineage-members', () => ({
  useLineageMembers: (key: string | null) => {
    lineage.keys.push(key)
    return { ...lineage.result, refresh: async () => {} }
  }
}))
vi.mock('../lineage/LineageSourceControlSections', () => ({
  LineageSourceControlSections: ({
    members,
    parentWorkspaceKey
  }: {
    members: LineageMember[]
    parentWorkspaceKey?: string
  }) => (
    <div data-testid="lineage-source-control" data-tower={parentWorkspaceKey ?? ''}>
      {members.map((member) => member.repoName).join(',')}
    </div>
  )
}))
vi.mock('./panel-ready', () => ({
  SourceControlPanelReady: function StandardPanelStub() {
    const entry = useContext(AddToTowerEntryContext)
    return (
      <div data-testid="standard-source-control" data-add-entry={entry?.parentWorkspaceKey ?? ''} />
    )
  }
}))
vi.mock('./use-panel-model', () => ({
  useSourceControlPanelModel: () => ({
    activeRepo: { id: 'repo1' },
    activeWorktree: { id: 'repo1::/w/tower' },
    isFolder: false,
    worktreePath: '/w/tower'
  })
}))

import { SourceControlPanel } from './panel'

const TOWER_ID = 'repo1::/w/tower'
const towerSelf: LineageMember = {
  repoName: 'repo1',
  branch: 'feat/ABC-1',
  worktreeId: TOWER_ID,
  worktreePath: '/w/tower',
  matchedBy: 'lineage',
  reasons: ['this workspace']
}
const child: LineageMember = {
  repoName: 'api',
  branch: 'feat/ABC-1',
  worktreeId: 'api::/w/api',
  worktreePath: '/w/api',
  matchedBy: 'pattern',
  reasons: []
}

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  lineage.keys = []
  lineage.result = { members: [], loading: false, supported: true }
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({ activeWorktreeId: TOWER_ID, activeWorkspaceKey: `worktree:${TOWER_ID}` })
})

afterEach(cleanup)

describe('SourceControlPanel lineage routing', () => {
  it('keeps the standard panel for a plain workspace whose only member is itself', () => {
    lineage.result = { members: [{ ...towerSelf, isTower: true }], loading: false, supported: true }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control')).toBeTruthy()
    expect(screen.queryByTestId('lineage-source-control')).toBeNull()
  })

  it('keeps the standard panel for an unflagged self-only list from an older host', () => {
    lineage.result = { members: [towerSelf], loading: false, supported: true }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control')).toBeTruthy()
  })

  it('routes a tower with a child to per-member sections for the same key Checks uses', () => {
    lineage.result = {
      members: [{ ...towerSelf, isTower: true }, child],
      loading: false,
      supported: true
    }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('lineage-source-control').textContent).toBe('repo1,api')
    expect(screen.queryByTestId('standard-source-control')).toBeNull()
    expect(lineage.keys.at(-1)).toBe(`worktree:${TOWER_ID}`)
  })

  it('keeps the standard panel on a host that cannot list members', () => {
    lineage.result = { members: [child], loading: false, supported: false }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control')).toBeTruthy()
  })

  it('renders the standard panel while members are loading', () => {
    lineage.result = { members: [], loading: true, supported: false }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control')).toBeTruthy()
  })

  it('hands the tower key to the sections so they can add and remove', () => {
    lineage.result = {
      members: [{ ...towerSelf, isTower: true }, child],
      loading: false,
      supported: true
    }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('lineage-source-control').dataset.tower).toBe(`worktree:${TOWER_ID}`)
  })

  it('offers the add entry to the standard panel only while the host supports lineage', () => {
    lineage.result = { members: [{ ...towerSelf, isTower: true }], loading: false, supported: true }
    const { unmount } = render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control').dataset.addEntry).toBe(
      `worktree:${TOWER_ID}`
    )
    unmount()
    lineage.result = { members: [], loading: false, supported: false }
    render(<SourceControlPanel />)
    expect(screen.getByTestId('standard-source-control').dataset.addEntry).toBe('')
  })
})
