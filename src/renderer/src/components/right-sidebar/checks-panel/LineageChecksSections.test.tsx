// why: the sections render through React DOM, so @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { useChecksPanelTargetWorktree } from './checks-panel-target-worktree'

const linkOpener = vi.hoisted(() => ({ openHttpLink: vi.fn() }))
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openHttpLink: linkOpener.openHttpLink
}))

import { LineageChecksSections } from './LineageChecksSections'

const initialAppState = useAppStore.getInitialState()
const apiWorktree = makeWorktree({
  id: 'repo-api::/w/api',
  repoId: 'repo-api',
  path: '/w/api'
})
const webWorktree = makeWorktree({
  id: 'repo-web::/w/web',
  repoId: 'repo-web',
  path: '/w/web'
})

const members: LineageMember[] = [
  {
    repoName: 'api',
    branch: 'feat/ABC-1',
    worktreeId: apiWorktree.id,
    worktreePath: apiWorktree.path,
    matchedBy: 'pattern',
    reasons: ['branch matches ABC-1'],
    pr: { number: 12 }
  },
  {
    repoName: 'web',
    branch: 'feat/ABC-1',
    worktreePath: webWorktree.path,
    matchedBy: 'lineage',
    reasons: [],
    pr: { number: 7 }
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

const panelMounts: string[] = []

function StubPanel(): React.JSX.Element {
  const target = useChecksPanelTargetWorktree()
  panelMounts.push(target?.worktree?.id ?? 'none')
  return <div data-testid="original-panel">{target?.worktree?.id}</div>
}

beforeEach(() => {
  panelMounts.length = 0
  linkOpener.openHttpLink.mockReset()
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    worktreesByRepo: { 'repo-api': [apiWorktree], 'repo-web': [webWorktree] }
  })
})

afterEach(cleanup)

describe('LineageChecksSections', () => {
  it('labels a GitLab merge request !n and an unknown provider #n', () => {
    const gitlab: LineageMember[] = [
      { ...members[0], pr: { number: 12, provider: 'gitlab' } },
      { ...members[1], pr: { number: 7 } }
    ]
    render(<LineageChecksSections members={gitlab} PanelComponent={StubPanel} />)
    const sections = screen.getAllByTestId(/^lineage-checks-section-/)
    expect(within(sections[0]).getByText('!12')).toBeTruthy()
    expect(within(sections[1]).getByText('#7')).toBeTruthy()
  })

  it('renders one collapse per repository in member order with only the first expanded', () => {
    render(<LineageChecksSections members={members} PanelComponent={StubPanel} />)

    const sections = screen.getAllByTestId(/^lineage-checks-section-/)
    expect(sections.map((section) => section.dataset.testid)).toEqual([
      'lineage-checks-section-api',
      'lineage-checks-section-web'
    ])
    const apiHeader = within(sections[0]).getByRole('button', { name: /api/ })
    expect(apiHeader.getAttribute('aria-expanded')).toBe('true')
    expect(within(sections[0]).getByTestId('lineage-origin-badge').textContent).toBe('pattern')
    expect(within(sections[0]).getByText('#12')).toBeTruthy()
    expect(within(sections[1]).getByText('#7')).toBeTruthy()
    expect(
      within(sections[1]).getByRole('button', { name: /web/ }).getAttribute('aria-expanded')
    ).toBe('false')

    expect(screen.getAllByTestId('original-panel').map((panel) => panel.textContent)).toEqual([
      apiWorktree.id
    ])
    expect(panelMounts).not.toContain(webWorktree.id)
  })

  it('mounts the original panel for a section only once it is expanded', () => {
    render(<LineageChecksSections members={members} PanelComponent={StubPanel} />)

    fireEvent.click(screen.getByRole('button', { name: /web/ }))

    expect(screen.getAllByTestId('original-panel').map((panel) => panel.textContent)).toEqual([
      apiWorktree.id,
      webWorktree.id
    ])
  })

  it('renders a worktree-less manual pull request as a compact row without a panel', () => {
    render(<LineageChecksSections members={members} PanelComponent={StubPanel} />)

    const row = screen.getByTestId('lineage-checks-pr-row-docs-5')
    expect(within(row).getByText('docs#5')).toBeTruthy()
    expect(within(row).getByTestId('lineage-origin-badge').textContent).toBe('manual')
    expect(within(row).queryByTestId('original-panel')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Open docs#5' }))
    expect(linkOpener.openHttpLink).toHaveBeenCalledWith('https://github.com/acme/docs/pull/5')
  })

  it('prefers the pull request title in a compact row and omits the link without a url', () => {
    render(
      <LineageChecksSections
        members={[
          {
            repoName: 'docs',
            branch: '',
            matchedBy: 'manual',
            reasons: [],
            pr: { number: 9, title: 'Document ABC-1' }
          }
        ]}
        PanelComponent={StubPanel}
      />
    )

    const row = screen.getByTestId('lineage-checks-pr-row-docs-9')
    expect(within(row).getByText('Document ABC-1')).toBeTruthy()
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('offers Remove only for manual members and unlinks then refreshes', async () => {
    const removeLink = vi.fn().mockResolvedValue({ success: true })
    const onMembersChanged = vi.fn()
    const originalApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { ...originalApi, git: { lineageRemoveManualLink: removeLink } }
    })
    try {
      render(
        <LineageChecksSections
          members={members}
          PanelComponent={StubPanel}
          parentWorkspaceKey="tower"
          onMembersChanged={onMembersChanged}
        />
      )
      expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Remove docs#5' }))
      await waitFor(() =>
        expect(removeLink).toHaveBeenCalledWith({
          parentWorkspaceKey: 'tower',
          linkId: 'm1'
        })
      )
      await waitFor(() => expect(onMembersChanged).toHaveBeenCalled())
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: originalApi
      })
    }
  })

  it('renders the shared add control in the sections header when a workspace key is given', async () => {
    const { rerender } = render(
      <LineageChecksSections members={members} PanelComponent={StubPanel} />
    )
    expect(screen.queryByRole('button', { name: 'Add to control tower…' })).toBeNull()
    rerender(
      <LineageChecksSections
        members={members}
        PanelComponent={StubPanel}
        parentWorkspaceKey="tower"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add to control tower…' }))
    expect(await screen.findByRole('dialog', { name: 'Add to control tower' })).toBeTruthy()
  })

  it('offers Remove on the sub-row of a manual worktree when a repo has several', async () => {
    const removeLink = vi.fn().mockResolvedValue({ success: true })
    const second = makeWorktree({ id: 'repo-api::/w/api-2', repoId: 'repo-api', path: '/w/api-2' })
    useAppStore.setState({
      worktreesByRepo: { 'repo-api': [apiWorktree, second], 'repo-web': [webWorktree] }
    })
    const originalApi = window.api
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { ...originalApi, git: { lineageRemoveManualLink: removeLink } }
    })
    try {
      render(
        <LineageChecksSections
          members={[
            members[0],
            {
              repoName: 'api',
              branch: 'feat/manual',
              worktreeId: second.id,
              worktreePath: second.path,
              matchedBy: 'manual',
              reasons: ['added manually'],
              manualLinkId: 'm2'
            }
          ]}
          PanelComponent={StubPanel}
          parentWorkspaceKey="tower"
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Remove api (feat/manual)' }))
      await waitFor(() =>
        expect(removeLink).toHaveBeenCalledWith({ parentWorkspaceKey: 'tower', linkId: 'm2' })
      )
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: originalApi
      })
    }
  })
})
