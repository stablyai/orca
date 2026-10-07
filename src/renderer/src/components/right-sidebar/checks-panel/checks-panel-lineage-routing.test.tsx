// why: the panel renders through React DOM, so @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import { useAppStore } from '@/store'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

type LineageMembersStub = { members: LineageMember[]; loading: boolean; supported: boolean }

const lineage = vi.hoisted(() => {
  const keys: (string | null)[] = []
  const result: LineageMembersStub = { members: [], loading: false, supported: true }
  return { keys, result }
})

vi.mock('../lineage-members/use-lineage-members', () => ({
  useLineageMembers: (key: string | null) => {
    lineage.keys.push(key)
    return { ...lineage.result, refresh: async () => {} }
  }
}))
vi.mock('./LineageChecksSections', () => ({
  LineageChecksSections: ({ members }: { members: LineageMember[] }) => (
    <div data-testid="lineage-checks-sections">{members.length}</div>
  )
}))
vi.mock('../HostedReviewActions', () => ({ default: () => null }))
vi.mock('../SourceControlAgentActionDialog', () => ({
  SourceControlAgentActionDialog: () => null
}))

import ChecksPanel from '../ChecksPanel'

const confirmNothing = async (): Promise<boolean> => false

function renderPanel(): ReturnType<typeof render> {
  return render(
    <ConfirmationDialogContext.Provider value={confirmNothing}>
      <ChecksPanel />
    </ConfirmationDialogContext.Provider>
  )
}

const initialAppState = useAppStore.getInitialState()
const member: LineageMember = {
  repoName: 'api',
  branch: 'feat/ABC-1',
  worktreePath: '/w/api',
  matchedBy: 'pattern',
  reasons: []
}

beforeEach(() => {
  lineage.keys = []
  lineage.result = { members: [], loading: false, supported: true }
  useAppStore.setState(initialAppState, true)
})

afterEach(cleanup)

const TOWER_ID = 'repo1::/w/tower'
const towerSelf: LineageMember = {
  repoName: 'repo1',
  branch: 'feat/ABC-1',
  worktreeId: TOWER_ID,
  worktreePath: '/w/tower',
  matchedBy: 'lineage',
  reasons: ['this workspace']
}

describe('ChecksPanel tower routing', () => {
  beforeEach(() => {
    useAppStore.setState({ activeWorktreeId: TOWER_ID })
  })

  it('keeps the single panel for a self-only list flagged as the tower', () => {
    lineage.result = { members: [{ ...towerSelf, isTower: true }], loading: false, supported: true }

    renderPanel()

    expect(screen.queryByTestId('lineage-checks-sections')).toBeNull()
    expect(screen.getByText('No workspace selected')).toBeTruthy()
  })

  it('keeps the single panel for a self-only list from a host that sends no tower flag', () => {
    lineage.result = { members: [towerSelf], loading: false, supported: true }

    renderPanel()

    expect(screen.queryByTestId('lineage-checks-sections')).toBeNull()
    expect(screen.getByText('No workspace selected')).toBeTruthy()
  })

  it('renders sections for the tower plus a child', () => {
    lineage.result = {
      members: [{ ...towerSelf, isTower: true }, member],
      loading: false,
      supported: true
    }

    renderPanel()

    expect(screen.getByTestId('lineage-checks-sections').textContent).toBe('2')
  })

  it('renders sections for a folder tower that has only child members', () => {
    useAppStore.setState({ activeWorkspaceKey: 'folder:tower-1', activeWorktreeId: null })
    lineage.result = { members: [member], loading: false, supported: true }

    renderPanel()

    expect(lineage.keys.at(-1)).toBe('folder:tower-1')
    expect(screen.getByTestId('lineage-checks-sections').textContent).toBe('1')
  })

  it('renders sections for a manual-only member list', () => {
    lineage.result = {
      members: [
        {
          repoName: 'docs',
          branch: '',
          matchedBy: 'manual',
          reasons: [],
          pr: { number: 5 },
          manualLinkId: 'm1'
        }
      ],
      loading: false,
      supported: true
    }

    renderPanel()

    expect(screen.getByTestId('lineage-checks-sections').textContent).toBe('1')
  })
})

describe('ChecksPanel lineage routing', () => {
  it('renders the single-worktree panel when the tower has no members', () => {
    renderPanel()

    expect(screen.getByText('No workspace selected')).toBeTruthy()
    expect(screen.queryByTestId('lineage-checks-sections')).toBeNull()
  })

  it('renders the single-worktree panel when the host cannot list members', () => {
    lineage.result = { members: [member], loading: false, supported: false }

    renderPanel()

    expect(screen.getByText('No workspace selected')).toBeTruthy()
    expect(screen.queryByTestId('lineage-checks-sections')).toBeNull()
  })

  it('renders one section list when the tower has members', () => {
    lineage.result = { members: [member], loading: false, supported: true }

    renderPanel()

    expect(screen.getByTestId('lineage-checks-sections').textContent).toBe('1')
    expect(screen.queryByText('No workspace selected')).toBeNull()
  })

  it('asks for members of the active workspace key, falling back to the active worktree', () => {
    useAppStore.setState({
      activeWorkspaceKey: null,
      activeWorktreeId: 'repo1::/repo1'
    })
    const { unmount } = renderPanel()
    expect(lineage.keys.at(-1)).toBe('repo1::/repo1')
    unmount()

    useAppStore.setState({ activeWorkspaceKey: 'folder:tower-1' })
    renderPanel()
    expect(lineage.keys.at(-1)).toBe('folder:tower-1')
  })
})
