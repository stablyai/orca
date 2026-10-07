// why: the sections render through React DOM, so @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageMember } from '../../../../../../shared/lineage-discovery-types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { useSourceControlTargetWorktree } from '../panel/source-control-target-worktree'

const linkOpener = vi.hoisted(() => ({ openHttpLink: vi.fn() }))
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openHttpLink: linkOpener.openHttpLink
}))

import { LineageSourceControlSections } from './LineageSourceControlSections'

const initialAppState = useAppStore.getInitialState()
const towerWorktree = makeWorktree({ id: 'repo-ui::/w/ui', repoId: 'repo-ui', path: '/w/ui' })
const apiWorktree = makeWorktree({
  id: 'repo-api::/w/api',
  repoId: 'repo-api',
  path: '/w/api',
  branch: 'refs/heads/feat/ABC-1'
})
const apiSecondWorktree = makeWorktree({
  id: 'repo-api::/w/api-2',
  repoId: 'repo-api',
  path: '/w/api-2'
})

const members: LineageMember[] = [
  {
    repoName: 'ui',
    branch: 'feat/ABC-1',
    worktreeId: towerWorktree.id,
    worktreePath: towerWorktree.path,
    matchedBy: 'lineage',
    reasons: ['this workspace'],
    isTower: true
  },
  {
    repoName: 'api',
    branch: 'feat/ABC-1',
    worktreeId: apiWorktree.id,
    worktreePath: apiWorktree.path,
    matchedBy: 'pattern',
    reasons: ['branch matches ABC-1']
  },
  {
    repoName: 'api',
    branch: 'fix/ABC-1-followup',
    worktreePath: apiSecondWorktree.path,
    matchedBy: 'lineage',
    reasons: [],
    unverifiable: true
  },
  {
    repoName: 'docs',
    branch: '',
    matchedBy: 'manual',
    reasons: ['linked manually'],
    pr: { number: 5, url: 'https://github.com/acme/docs/pull/5' },
    manualLinkId: 'm1'
  }
]

type Mount = { worktreeId: string | undefined; isActive: boolean | undefined }
const panelMounts: Mount[] = []

function StubPanel(): React.JSX.Element {
  const target = useSourceControlTargetWorktree()
  panelMounts.push({ worktreeId: target?.worktree?.id, isActive: target?.isActive })
  return <div data-testid="original-panel">{target?.worktree?.id}</div>
}

beforeEach(() => {
  panelMounts.length = 0
  linkOpener.openHttpLink.mockReset()
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeWorktreeId: towerWorktree.id,
    worktreesByRepo: {
      'repo-ui': [towerWorktree],
      'repo-api': [apiWorktree, apiSecondWorktree]
    },
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control'
  })
})

afterEach(cleanup)

describe('LineageSourceControlSections', () => {
  it('renders one collapse per member worktree in member order, tower first and open', () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)

    const sections = screen.getAllByTestId(/^lineage-source-control-section-/)
    expect(sections.map((section) => section.getAttribute('data-testid'))).toEqual([
      `lineage-source-control-section-${towerWorktree.id}`,
      `lineage-source-control-section-${apiWorktree.id}`,
      `lineage-source-control-section-${apiSecondWorktree.id}`
    ])
    expect(screen.getAllByTestId('original-panel').map((panel) => panel.textContent)).toEqual([
      towerWorktree.id
    ])
    expect(within(sections[1]).getByText('api')).toBeTruthy()
    expect(within(sections[1]).getByText('feat/ABC-1')).toBeTruthy()
    expect(within(sections[1]).getByTestId('lineage-origin-badge').textContent).toBe('pattern')
  })

  it('mounts no panel for a collapsed section and binds an expanded one to its worktree', () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    expect(new Set(panelMounts.map((mount) => mount.worktreeId))).toEqual(
      new Set([towerWorktree.id])
    )

    const apiSection = screen.getByTestId(`lineage-source-control-section-${apiWorktree.id}`)
    fireEvent.click(within(apiSection).getByRole('button'))

    expect(screen.getAllByTestId('original-panel').map((panel) => panel.textContent)).toEqual([
      towerWorktree.id,
      apiWorktree.id
    ])
    expect(panelMounts.at(-1)).toEqual({ worktreeId: apiWorktree.id, isActive: true })
  })

  it('marks every expanded section inactive while the sidebar shows another tab', () => {
    useAppStore.setState({ rightSidebarTab: 'checks' })
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    expect(panelMounts.at(-1)).toEqual({ worktreeId: towerWorktree.id, isActive: false })
  })

  it("names the worktree's checked-out branch over the branch the member reported", () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    const tower = screen.getByTestId(`lineage-source-control-section-${towerWorktree.id}`)
    expect(within(tower).getByText('feature')).toBeTruthy()
    expect(within(tower).queryByText('feat/ABC-1')).toBeNull()
  })

  it('labels an SSH member this host cannot inspect as unverifiable', () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    const remote = screen.getByTestId(`lineage-source-control-section-${apiSecondWorktree.id}`)
    expect(within(remote).getByText('unverifiable')).toBeTruthy()
    const local = screen.getByTestId(`lineage-source-control-section-${apiWorktree.id}`)
    expect(within(local).queryByText('unverifiable')).toBeNull()
  })

  it('shows only the collapse trigger in a section header', () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    const apiSection = screen.getByTestId(`lineage-source-control-section-${apiWorktree.id}`)
    expect(within(apiSection).getAllByRole('button')).toHaveLength(1)
  })

  it('renders a manual PR without a worktree as a compact row with an open link', () => {
    render(<LineageSourceControlSections members={members} PanelComponent={StubPanel} />)
    const row = screen.getByTestId('lineage-source-control-pr-row-m1')
    expect(within(row).getByText('docs#5')).toBeTruthy()
    expect(within(row).getByTestId('lineage-origin-badge').textContent).toBe('manual')
    fireEvent.click(within(row).getByRole('button', { name: 'Open docs#5' }))
    expect(linkOpener.openHttpLink).toHaveBeenCalledWith('https://github.com/acme/docs/pull/5')
    expect(panelMounts.some((mount) => mount.worktreeId === undefined)).toBe(false)
  })

  it('offers the shared add control only when a workspace key is given', async () => {
    const { rerender } = render(
      <LineageSourceControlSections members={members} PanelComponent={StubPanel} />
    )
    expect(screen.queryByRole('button', { name: 'Add to control tower…' })).toBeNull()
    rerender(
      <LineageSourceControlSections
        members={members}
        PanelComponent={StubPanel}
        parentWorkspaceKey="tower"
        onMembersChanged={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add to control tower…' }))
    expect(await screen.findByRole('dialog', { name: 'Add to control tower' })).toBeTruthy()
  })

  it('removes a manual member from its section header and from a compact row', async () => {
    const removeLink = vi.fn().mockResolvedValue({ success: true })
    const onMembersChanged = vi.fn()
    const originalApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { ...originalApi, git: { lineageRemoveManualLink: removeLink } }
    })
    const manualWorktree: LineageMember = { ...members[1], matchedBy: 'manual', manualLinkId: 'm9' }
    try {
      render(
        <LineageSourceControlSections
          members={[members[0], manualWorktree, members[3]]}
          PanelComponent={StubPanel}
          parentWorkspaceKey="tower"
          onMembersChanged={onMembersChanged}
        />
      )
      const section = screen.getByTestId(`lineage-source-control-section-${apiWorktree.id}`)
      fireEvent.click(within(section).getByRole('button', { name: 'Remove api (feat/ABC-1)' }))
      await waitFor(() =>
        expect(removeLink).toHaveBeenCalledWith({ parentWorkspaceKey: 'tower', linkId: 'm9' })
      )
      const row = screen.getByTestId('lineage-source-control-pr-row-m1')
      fireEvent.click(within(row).getByRole('button', { name: 'Remove docs#5' }))
      await waitFor(() =>
        expect(removeLink).toHaveBeenCalledWith({ parentWorkspaceKey: 'tower', linkId: 'm1' })
      )
      await waitFor(() => expect(onMembersChanged).toHaveBeenCalledTimes(2))
      const tower = screen.getByTestId(`lineage-source-control-section-${towerWorktree.id}`)
      expect(within(tower).queryByRole('button', { name: /^Remove / })).toBeNull()
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: originalApi
      })
    }
  })
})
