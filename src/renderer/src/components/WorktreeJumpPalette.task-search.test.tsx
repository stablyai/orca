// @vitest-environment happy-dom
import { act, forwardRef, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { jiraTaskIssue as issue } from './cmd-j/task-search.test-fixture'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'
import type * as ReactI18next from 'react-i18next'
import type * as RuntimeJiraClient from '@/runtime/runtime-jira-client'
import { jiraSearchIssuesForTarget, jiraStatusForTarget } from '@/runtime/runtime-jira-client'
import WorktreeJumpPalette from './WorktreeJumpPalette'

vi.mock('@/runtime/runtime-jira-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeJiraClient>()),
  jiraStatusForTarget: vi.fn(),
  jiraSearchIssuesForTarget: vi.fn()
}))
vi.mock('@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover', () => ({
  WorkspaceEmojiSuggestionPopover: () => null
}))
vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (_: string, fallback: string) => fallback })
}))
vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  CommandInput: forwardRef<
    HTMLInputElement,
    { value: string; onValueChange: (value: string) => void }
  >(function Input({ value, onValueChange }, ref) {
    return (
      <input
        ref={ref}
        aria-label="Palette search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      />
    )
  }),
  CommandList: forwardRef<HTMLDivElement, { children: ReactNode }>(function List(
    { children },
    ref
  ) {
    return <div ref={ref}>{children}</div>
  }),
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value
  }: {
    children: ReactNode
    onSelect: () => void
    value: string
  }) => (
    <button cmdk-item="" data-value={value} onClick={onSelect}>
      {children}
    </button>
  )
}))

const initial = useAppStore.getInitialState()
const search = vi.mocked(jiraSearchIssuesForTarget)
const openTaskPage = vi.fn()
beforeEach(() => {
  useAppStore.setState(initial, true)
  search.mockReset().mockResolvedValue([issue])
  vi.mocked(jiraStatusForTarget)
    .mockReset()
    .mockResolvedValue({
      connected: true,
      viewer: null,
      selectedSiteId: 'all',
      sites: [
        {
          id: 'other-site',
          siteUrl: 'https://other.atlassian.net',
          email: 'other@example.com',
          displayName: 'Other Jira',
          accountId: 'other'
        }
      ]
    })
  openTaskPage.mockClear()
  useAppStore.setState({
    activeModal: 'worktree-palette',
    repos: [],
    worktreesByRepo: {},
    settings: createGlobalSettingsFixture({ visibleTaskProviders: ['jira'] }),
    openTaskPage
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('finds an unlinked Jira task from keywords and opens detail with the returned site/account identity', async () => {
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByLabelText('Palette search'), { target: { value: 'login redirect' } })
  await waitFor(() => expect(screen.queryByText('Fix login redirect')).not.toBeNull(), {
    timeout: 2000
  })
  expect(screen.getByText('Tasks')).toBeTruthy()
  expect(search).toHaveBeenCalledWith(
    { kind: 'local' },
    'text ~ "login redirect*"',
    expect.any(Number),
    'all',
    expect.any(AbortSignal)
  )
  await act(async () => {
    fireEvent.click(screen.getByText('Fix login redirect'))
  })
  expect(openTaskPage).toHaveBeenCalledWith(
    expect.objectContaining({
      taskSource: 'jira',
      openJiraIssue: issue,
      openJiraSourceContext: expect.objectContaining({
        hostId: 'local',
        accountLabel: 'other@example.com',
        providerIdentity: expect.objectContaining({
          siteId: 'other-site',
          siteUrl: 'https://other.atlassian.net'
        })
      })
    }),
    expect.anything()
  )
})

it('shows local matches while a provider request is still pending', async () => {
  search.mockImplementation(() => new Promise(() => {}))
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('local', 'login redirect workspace')] }
  })
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByLabelText('Palette search'), { target: { value: 'login redirect' } })
  expect(screen.getByRole('button', { name: /login redirect workspace/ })).toBeTruthy()
  await waitFor(() => expect(search).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: /login redirect workspace/ })).toBeTruthy()
})

it('discards a previous query response and aborts its Jira request', async () => {
  let complete: (value: (typeof issue)[]) => void = () => {}
  search.mockImplementationOnce(
    () =>
      new Promise<(typeof issue)[]>((resolve) => {
        complete = resolve
      })
  )
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByLabelText('Palette search'), { target: { value: 'old query' } })
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
  const firstSignal = search.mock.calls[0]?.[4]
  search.mockResolvedValueOnce([{ ...issue, title: 'Current query result' }])
  fireEvent.change(screen.getByLabelText('Palette search'), { target: { value: 'current query' } })
  await waitFor(() => expect(screen.queryByText('Current query result')).not.toBeNull())
  await act(async () => complete([issue]))
  expect(firstSignal?.aborted).toBe(true)
  expect(screen.queryByText('Fix login redirect')).toBeNull()
})

it('keeps local results and offers a retry after a provider failure', async () => {
  search.mockRejectedValueOnce(new Error('Offline'))
  useAppStore.setState({
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('local', 'login redirect workspace')] }
  })
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByLabelText('Palette search'), { target: { value: 'login redirect' } })
  await waitFor(() =>
    expect(screen.queryByText(/Some task sources could not be searched/)).not.toBeNull()
  )
  expect(screen.getByRole('button', { name: /login redirect workspace/ })).toBeTruthy()
  fireEvent.click(screen.getByText('Retry'))
  await waitFor(() => expect(screen.queryByText('Fix login redirect')).not.toBeNull())
})
