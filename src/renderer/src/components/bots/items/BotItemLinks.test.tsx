// @vitest-environment happy-dom

import { cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'

const openAppHttpLink = vi.fn()
const statUserOpenedPath = vi.fn()
const openLinkedFileInEditor = vi.fn()
const toastError = vi.spyOn(toast, 'error')
vi.mock(import('@/lib/browser/navigation/app-http-link-open'), async (importOriginal) => ({
  ...(await importOriginal()),
  openAppHttpLink: (...args: Parameters<typeof openAppHttpLink>) => openAppHttpLink(...args)
}))
vi.mock('@/lib/files/access/user-opened-local-path', () => ({
  statUserOpenedPath: (...args: unknown[]) => statUserOpenedPath(...args)
}))
vi.mock('@/components/terminal-pane/links/files/terminal-file-link-editor-open', () => ({
  openLinkedFileInEditor: (...args: unknown[]) => openLinkedFileInEditor(...args)
}))
vi.mock('@/lib/workspace/activation/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activateAndRevealWorkspace: () => true
}))
const FOLDER = '/bots/reviewer'
vi.mock('../BotGroupTranscriptOwner', () => ({
  useBotGroupFileContexts: () =>
    new Map([
      [
        'bot-1',
        {
          fileLinkContext: {
            worktreeId: 'folder:w1',
            worktreePath: FOLDER,
            runtimeEnvironmentId: null
          },
          runtimeContext: {
            target: { kind: 'local' },
            worktreeId: 'folder:w1',
            worktreePath: FOLDER
          }
        }
      ]
    ])
}))

const { BotItemLinks } = await import('./BotItemLinks')
const { useAppStore } = await import('@/store')
const render = (ui: ReactElement) => renderBare(ui, { wrapper: TooltipProvider })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const BOT: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const LINKS: BotItemLinkView[] = [
  { kind: 'file', ref: 'notes/mock.html' },
  { kind: 'url', ref: 'https://example.com/docs/a' },
  { kind: 'url', ref: 'https://acme.slack.com/archives/C1/p2' },
  { kind: 'url', ref: 'https://linear.app/acme/issue/eng-12/fix' },
  { kind: 'url', ref: 'https://github.com/acme/app/issues/7' },
  {
    kind: 'pr',
    ref: 'acme/app#9',
    pr: {
      shown: true,
      ref: 'acme/app#9',
      number: 9,
      url: 'https://github.com/acme/app/pull/9',
      state: 'merged',
      checks: 'success',
      review: null,
      checkedAt: 1
    }
  },
  { kind: 'pr', ref: 'acme/app#10', pr: null }
]

function rows(): HTMLElement[] {
  render(<BotItemLinks bot={BOT} links={LINKS} chat="Home Chat" />)
  return screen.getAllByRole('button')
}

it.each([
  ['https://example.com/docs/a', 'example.com'],
  ['notes/mock.html', 'notes/mock.html']
])('puts what a second line would say on hover: %s', async (ref, tip) => {
  const kind = ref.startsWith('https:') ? 'url' : 'file'
  render(<BotItemLinks bot={BOT} links={[{ kind, ref }]} chat="Home Chat" />)
  fireEvent.focus(screen.getByRole('button'))
  expect((await screen.findByRole('tooltip')).textContent).toBe(tip)
})

const FIX_LOGIN: LinearIssue = {
  id: 'lin-1',
  identifier: 'ENG-12',
  title: 'Fix login',
  url: 'https://linear.app/acme/issue/eng-12',
  state: { name: 'Todo', type: 'unstarted', color: '#999999' },
  team: { id: 't1', name: 'Eng', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-11-14T00:00:00Z'
}

it('titles a Linear issue from Orca’s Linear cache, beside its identifier', () => {
  useAppStore.setState({
    linearIssueCache: {
      'ENG-12': { data: FIX_LOGIN, fetchedAt: 1 }
    }
  })
  render(
    <BotItemLinks
      bot={BOT}
      links={[{ kind: 'url', ref: 'https://linear.app/acme/issue/eng-12/fix' }]}
      chat="Home Chat"
    />
  )
  expect(screen.getByRole('button').textContent).toBe('Fix loginENG-12')
  useAppStore.setState({ linearIssueCache: {} })
})

type PrState = 'open' | 'draft' | 'merged' | 'closed'
const prLink = (
  repo: string,
  number: number,
  state: PrState,
  checks: string | null,
  title: string | null = `Title ${number}`
): BotItemLinkView => ({
  kind: 'pr',
  ref: `${repo}#${number}`,
  pr: {
    shown: true,
    ref: `${repo}#${number}`,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    state,
    checks,
    review: null,
    title,
    checkedAt: 1
  }
})

function only(link: BotItemLinkView): HTMLElement {
  render(<BotItemLinks bot={BOT} links={[link]} chat="Home Chat" />)
  return screen.getByRole('button')
}

it('uses the cached issue title beside its number', () => {
  const row = only({
    kind: 'url',
    ref: 'https://github.com/acme/app/issues/7',
    issue: { title: 'Viewers can edit', state: 'open' }
  })
  expect(row.textContent).toBe('Viewers can edit#7')
})

it.each([
  ['open', 'failure', 'Checks failing'],
  ['draft', 'success', 'Checks passing'],
  ['open', 'pending', null],
  ['merged', 'success', null],
  ['closed', 'failure', null]
] as const)('a %s PR with %s checks shows CI glyph %s', (state, checks, label) => {
  only(prLink('acme/app', 9, state, checks))
  const glyph = screen.queryByRole('img')
  expect(glyph?.getAttribute('aria-label') ?? null).toBe(label)
})

it('uses cached titles when available and names the repo only on external links', () => {
  render(
    <BotItemLinks
      bot={BOT}
      links={[
        prLink('acme/app', 1, 'open', null, 'Share dialog'),
        prLink('acme/app', 2, 'merged', null, null),
        prLink('acme/infra', 3, 'closed', null),
        { kind: 'pr', ref: 'acme/infra#4', pr: null }
      ]}
      chat="Home Chat"
    />
  )
  expect(screen.getAllByRole('button').map((row) => row.textContent)).toEqual([
    'Share dialog#1',
    'PR #2',
    'Title 3acme/infra#3',
    'PR #4acme/infra'
  ])
})

it('opens web links through the app link opener', () => {
  const all = rows()
  fireEvent.click(all[1]!)
  expect(openAppHttpLink).toHaveBeenCalledWith(
    'https://github.com/acme/app/pull/9',
    expect.objectContaining({ event: expect.anything() })
  )
  fireEvent.click(all[2]!)
  expect(openAppHttpLink).toHaveBeenLastCalledWith(
    'https://github.com/acme/app/pull/10',
    expect.anything()
  )
})

function clickFile(ref: string): void {
  render(<BotItemLinks bot={BOT} links={[{ kind: 'file', ref }]} chat="Home Chat" />)
  fireEvent.click(screen.getByRole('button'))
}

it('opens an HTML file link in the editor, never a browser', async () => {
  statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: false })
  clickFile('notes/mock.html')
  await waitFor(() =>
    expect(openLinkedFileInEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/bots/reviewer/notes/mock.html',
        relativePath: 'notes/mock.html',
        worktreeId: 'folder:w1'
      }),
      null,
      { line: null, column: null },
      expect.any(Function)
    )
  )
  expect(openAppHttpLink).not.toHaveBeenCalled()
})

it.each(['../other/secret.txt', '/etc/hosts', 'notes/../../other/x.md'])(
  'refuses a file link outside the bot folder: %s',
  async (ref) => {
    clickFile(ref)
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(`${ref} isn't in this bot's folder`)
    )
    expect(statUserOpenedPath).not.toHaveBeenCalled()
    expect(openLinkedFileInEditor).not.toHaveBeenCalled()
  }
)

it('refuses a file link whose real path leaves the bot folder through a symlink', async () => {
  statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: true })
  clickFile('linked/secret.txt')
  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith("linked/secret.txt isn't in this bot's folder")
  )
  expect(openLinkedFileInEditor).not.toHaveBeenCalled()
})

describe('a PR merged since the host read it', () => {
  const merged: PRInfo = {
    number: 9,
    title: 'Title 9',
    state: 'merged',
    url: 'https://github.com/acme/app/pull/9',
    checksStatus: 'success',
    updatedAt: '2026-11-16T00:00:00Z',
    mergeable: 'UNKNOWN'
  }
  const original = useAppStore.getState()
  const enqueue = vi.fn()
  beforeEach(() => {
    useAppStore.setState({ enqueueGitHubPRRefresh: enqueue })
  })
  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState({
      prCache: original.prCache,
      enqueueGitHubPRRefresh: original.enqueueGitHubPRRefresh
    })
  })
  const workerPr = (state: PrState, checkedAt: number | null): BotItemLinkView => {
    const link = prLink('acme/app', 9, state, 'success')
    return link.kind === 'pr' && link.pr?.shown
      ? { ...link, pr: { ...link.pr, checkedAt, worktreeId: 'repo-1::/wt/fix' } }
      : link
  }

  it('uses the newer PR read from the host or this window and hides CI once merged', () => {
    useAppStore.setState({ prCache: { 'acme/app#fix': { data: merged, fetchedAt: 2 } } })
    const svg = only(prLink('acme/app', 9, 'open', 'success')).querySelector('svg')!
    expect(svg.classList.contains('lucide-git-merge')).toBe(true)
    expect(svg.classList.contains('text-purple-600')).toBe(true)
    expect(screen.queryByRole('img')).toBeNull()

    cleanup()
    useAppStore.setState({
      prCache: { 'acme/app#fix': { data: { ...merged, state: 'open' }, fetchedAt: 0 } }
    })
    const host = only(prLink('acme/app', 9, 'merged', null)).querySelector('svg')!
    expect(host.classList.contains('lucide-git-merge')).toBe(true)
  })

  it('asks for a fresh read of a worker’s stale open PR, never of a fresh or settled one', () => {
    const now = 10_000_000
    vi.useFakeTimers({ toFake: ['Date'], now })
    only(workerPr('open', 1))
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('repo-1::/wt/fix', 'active', 40)
    cleanup()
    enqueue.mockClear()
    only(workerPr('open', now - 1000))
    cleanup()
    only(workerPr('merged', 1))
    expect(enqueue).not.toHaveBeenCalled()
  })
})
