// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import type { Worktree, WorkspaceAttachment } from '../../../../shared/worktree/types'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import type { WorkspaceReferenceDetailsMap } from './workspace-reference-details'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/SelectedTextCopyMenu', () => ({
  SelectedTextCopyMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => (
    <div data-hover-open={String(open)}>
      <button onClick={() => onOpenChange(true)}>Hover workspace</button>
      {children}
    </div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-content="">{children}</div>
  )
}))
const attachments = [
  {
    provider: 'github',
    type: 'pr',
    number: 57,
    title: 'Active review',
    url: 'https://github.com/acme/orca/pull/57'
  },
  {
    provider: 'gitlab',
    type: 'mr',
    number: 42,
    title: 'Sibling review',
    url: 'https://gitlab.example.com/team/orca/-/merge_requests/42'
  },
  {
    provider: 'linear',
    type: 'issue',
    number: 0,
    identifier: 'ENG-215',
    title: 'Keyboard accessibility',
    url: 'https://linear.app/acme/issue/ENG-215/title'
  },
  {
    provider: 'jira',
    type: 'issue',
    number: 0,
    identifier: 'APP-18',
    title: 'Fix attachments',
    url: 'https://acme.atlassian.net/browse/APP-18'
  }
] satisfies WorkspaceAttachment[]
const workspace = makeWorktree({
  id: 'repo::/repo/feature',
  repoId: 'repo',
  hostId: 'ssh:owner',
  linkedPR: 57,
  linkedItems: attachments
})
const review = {
  provider: 'github' as const,
  number: 57,
  title: 'Active review',
  url: 'https://github.com/acme/orca/pull/57',
  status: 'success' as const
}
function Fixture({
  onManage,
  referenceDetails,
  worktree = workspace
}: {
  onManage: () => void
  referenceDetails?: WorkspaceReferenceDetailsMap
  worktree?: Worktree
}): React.JSX.Element {
  const hoverControl = useWorktreeCardDetailsHoverControl()
  return (
    <WorktreeCardDetailsHover
      workspace={worktree}
      referenceDetails={referenceDetails}
      review={review}
      issue={null}
      linearIssue={null}
      comment={null}
      onManageLinks={onManage}
      hoverControl={hoverControl}
    >
      <span>Workspace</span>
    </WorktreeCardDetailsHover>
  )
}
afterEach(cleanup)
describe('workspace linked references in hover details', () => {
  it('shows each fetched sibling status and target without applying primary checks to its peers', () => {
    const [, sibling, task] = attachments
    const details: WorkspaceReferenceDetailsMap = {
      [getWorkspaceAttachmentKey(sibling)]: {
        title: 'Merged sibling',
        url: sibling.url ?? '',
        review: {
          provider: 'gitlab',
          number: 42,
          title: 'Merged sibling',
          url: sibling.url,
          state: 'merged',
          status: 'neutral',
          baseRefName: 'release',
          updatedAt: '2026-10-07',
          mergeable: 'UNKNOWN'
        }
      },
      [getWorkspaceAttachmentKey(task)]: {
        title: 'Known task',
        url: task.url ?? '',
        stateName: 'In Progress'
      }
    }
    const { container } = render(<Fixture onManage={vi.fn()} referenceDetails={details} />)
    expect(screen.getByText('Merged sibling')).toBeTruthy()
    expect(screen.getByLabelText('State: Merged')).toBeTruthy()
    expect(screen.queryByText('State: Merged')).toBeNull()
    expect(screen.getByText('Target: release')).toBeTruthy()
    expect(screen.getByText('State: In Progress')).toBeTruthy()
    expect(screen.getAllByLabelText('Checks: Passing')).toHaveLength(1)
    expect(screen.queryByText('Used for checks')).toBeNull()
    const siblingRow = Array.from(
      container.querySelectorAll('[data-workspace-hover-reference]')
    ).find((node) => node.textContent?.includes('Merged sibling'))
    const icon = siblingRow?.querySelector('svg')
    expect(icon?.classList.contains('lucide-git-merge')).toBe(true)
    expect(icon?.classList.contains('dark:text-purple-400/70')).toBe(true)
  })
  it('offers Orca link destinations without activating the parent or dismissing hover', () => {
    const openUrl = vi.fn()
    Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
    const parentClick = vi.fn()
    const { container } = render(
      <div onClick={parentClick}>
        <Fixture onManage={vi.fn()} />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hover workspace' }))
    parentClick.mockClear()
    fireEvent.click(screen.getByRole('link', { name: 'Open MR !42' }))
    expect(openUrl).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /System Browser/ })).toBeTruthy()
    expect(parentClick).not.toHaveBeenCalled()
    expect(container.querySelector('[data-hover-open]')?.getAttribute('data-hover-open')).toBe(
      'true'
    )
  })
  it('dismisses the link chooser when an outside click stops propagation', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { openUrl: vi.fn() } }
    })
    render(
      <>
        <Fixture onManage={vi.fn()} />
        <button onClick={(event) => event.stopPropagation()}>Other card</button>
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hover workspace' }))
    fireEvent.click(screen.getByRole('link', { name: 'Open MR !42' }))
    // Why: Radix arms its outside-pointerdown listener a tick after opening.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    const otherCard = screen.getByRole('button', { name: 'Other card' })
    fireEvent.pointerDown(otherCard)
    fireEvent.click(otherCard)
    expect(screen.queryByRole('button', { name: /System Browser/ })).toBeNull()
  })
  it('lists the most recently linked references first', () => {
    render(<Fixture onManage={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hover workspace' }))
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(links.indexOf(attachments[1].url)).toBeLessThan(links.indexOf(attachments[0].url))
    expect(links.indexOf(attachments[3].url)).toBeLessThan(links.indexOf(attachments[2].url))
  })
  it('opens link management from either section header and dismisses hover', () => {
    const onManage = vi.fn()
    const { container } = render(<Fixture onManage={onManage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hover workspace' }))
    const addButtons = screen.getAllByRole('button', { name: 'Add reference' })
    expect(addButtons).toHaveLength(2)
    expect(screen.queryByText('Manage links…')).toBeNull()
    for (const button of addButtons) {
      fireEvent.click(screen.getByRole('button', { name: 'Hover workspace' }))
      fireEvent.click(button)
      expect(container.querySelector('[data-hover-open]')?.getAttribute('data-hover-open')).toBe(
        'false'
      )
    }
    expect(onManage).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('combobox')).toBeNull()
  })
  it('opens metadata management for a URL-less reference and handles attachment-only folders', () => {
    const onManage = vi.fn()
    const { container } = render(
      <WorktreeCardDetailsHover
        workspace={{
          ...workspace,
          id: 'folder:docs',
          linkedPR: null,
          linkedItems: [{ provider: 'gitea', type: 'pr', number: 7 }]
        }}
        onManageLinks={onManage}
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
      >
        <span>Folder</span>
      </WorktreeCardDetailsHover>
    )
    expect(container.querySelector('[data-workspace-hover-reference]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open PR #7' }))
    expect(onManage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Used for checks')).toBeNull()
  })
})
