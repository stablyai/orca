// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type {
  CommanderMemoryIndexQuery,
  CommanderMemoryIndexResult,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'
import { CommanderHandoffs } from './CommanderHandoffs'
import { recentCommanderGoal } from './recent-commander-goal'
import { resumeCommanderHandoff } from './open-commander-chat'

const state = vi.hoisted(() => ({
  activeOrcaProfileId: 'profile',
  orcaProfileSwitching: false,
  orcaProfileAuthStatus: {
    state: 'connected',
    activeProfileId: 'profile',
    cloud: { userId: 'user', activeOrgId: 'org' }
  },
  settings: null
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
vi.mock('./selected-commander-host', () => ({ selectedCommanderHost: () => ({ hostId: 'local' }) }))
vi.mock('@/components/comment-markdown/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>
}))
vi.mock('./open-commander-chat', () => ({ resumeCommanderHandoff: vi.fn() }))
vi.mock('./recent-commander-goal', () => ({ recentCommanderGoal: vi.fn() }))

const account = { profileId: 'profile', userId: 'user', activeOrgId: 'org' }
const props = { account, projectId: null, projectIds: ['github:org/app'] }
const original: CommanderMemoryRevision = {
  pageId: 'handoff-00000000-0000-4000-8000-000000000001',
  kind: 'note',
  title: 'Ship upgrade',
  body: '## Progress\n\nUI ready\n\n## Next step\n\nRun fixtures',
  projectId: null,
  links: [],
  actor: { type: 'human', id: 'user' },
  createdBy: { type: 'human', id: 'user' },
  createdAt: '2026-11-01T03:00:00Z',
  version: 1,
  deleted: false
}
const summary = ({ body: _body, links: _links, ...rest }: CommanderMemoryRevision) => rest
const api = (pages: CommanderMemoryRevision[] = []) => {
  const memory = {
    index: vi.fn(
      async (
        _account: typeof account,
        query: CommanderMemoryIndexQuery
      ): Promise<CommanderMemoryIndexResult> => ({
        pages: pages
          .filter((p) => !query.validHandoffsOnly || p.pageId.startsWith('handoff-'))
          .map(summary),
        projects: [],
        next: null
      })
    ),
    get: vi.fn(),
    save: vi.fn()
  }
  vi.stubGlobal('api', { commanderMemory: memory })
  return memory
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'org'
})

it('reads only handoff notes, compares changed revisions on resume and stages the reviewed version', async () => {
  const updated = { ...original, version: 2, title: 'Ship upgrade after review' }
  const memory = api([original, { ...original, pageId: 'note', title: 'Unrelated note' }])
  memory.get.mockResolvedValueOnce({ page: original }).mockResolvedValue({ page: updated })
  vi.mocked(resumeCommanderHandoff).mockResolvedValue(true)
  render(<CommanderHandoffs {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Ship upgrade/ }))
  expect(screen.queryByText('Unrelated note')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Resume in Commander' }))
  await screen.findByText(/Review the latest version/)
  expect(resumeCommanderHandoff).not.toHaveBeenCalled()
  expect(memory.get).not.toHaveBeenCalledWith(account, original.pageId, 2)
  memory.get.mockResolvedValueOnce({ page: updated, history: [original], nextBeforeVersion: null })
  fireEvent.click(screen.getByText('Revision history (2)'))
  fireEvent.click(await screen.findByRole('button', { name: 'Load older revisions' }))
  await screen.findByText('v1 · Ship upgrade · Human · user')
  expect(memory.get).toHaveBeenCalledWith(account, original.pageId, 2)
  fireEvent.click(screen.getByRole('button', { name: 'Resume in Commander' }))
  await waitFor(() =>
    expect(resumeCommanderHandoff).toHaveBeenCalledWith(
      expect.stringContaining('Goal: Ship upgrade after review'),
      expect.any(Function)
    )
  )
  const guard = vi.mocked(resumeCommanderHandoff).mock.calls[0][1]
  expect(guard()).toBe(true)
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'other'
  expect(guard()).toBe(false)
  expect(memory.save).not.toHaveBeenCalled()
})
it('previews recent conversation without writing, keeps the next step, and reuses the request on a failed save', async () => {
  const memory = api()
  memory.save.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ page: original })
  memory.get.mockRejectedValue(new Error('Offline'))
  vi.mocked(recentCommanderGoal).mockResolvedValue({ goal: 'Ship upgrade', progress: 'UI ready' })
  render(<CommanderHandoffs {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'New handoff' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Next step' }), {
    target: { value: 'Run fixtures' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use recent conversation' }))
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('Ship upgrade')
  )
  expect(screen.getByRole('textbox', { name: 'Next step' })).toHaveValue('Run fixtures')
  expect(memory.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await screen.findByText('Offline')
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await screen.findByRole('heading', { name: 'Ship upgrade' })
  expect(memory.save.mock.calls[0]).toEqual(memory.save.mock.calls[1])
  expect(memory.save.mock.calls[0]).toMatchObject([
    account,
    { expectedVersion: 0, title: 'Ship upgrade', body: original.body }
  ])
  expect(resumeCommanderHandoff).not.toHaveBeenCalled()
})
it('preserves the draft on conflict and rebases only after explicit review', async () => {
  const latest = {
    ...original,
    version: 3,
    links: ['external-link'],
    body: '## Progress\n\nLatest work\n\n## Next step\n\nReview latest work'
  }
  const memory = api([original])
  memory.get.mockResolvedValueOnce({ page: original }).mockResolvedValue({ page: latest })
  memory.save.mockRejectedValueOnce(new Error('Conflict')).mockResolvedValue({ page: latest })
  render(<CommanderHandoffs {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Ship upgrade/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit page' }))
  const progress = screen.getByRole('textbox', { name: 'Progress' })
  fireEvent.change(progress, { target: { value: 'My revised progress' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  const rebase = await screen.findByRole('button', { name: 'Keep my draft against this revision' })
  expect(progress).toHaveValue('My revised progress')
  expect(screen.getByRole('button', { name: 'Save revision' })).toBeDisabled()
  fireEvent.click(rebase)
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await waitFor(() => expect(memory.save).toHaveBeenCalledTimes(2))
  expect(memory.save.mock.calls[1]).toMatchObject([
    account,
    {
      expectedVersion: 3,
      links: ['external-link'],
      body: '## Progress\n\nMy revised progress\n\n## Next step\n\nRun fixtures'
    }
  ])
})
it('does not open a pending resume when the active organization changes', async () => {
  const memory = api([original])
  const pending = Promise.withResolvers<{ page: CommanderMemoryRevision }>()
  memory.get.mockResolvedValueOnce({ page: original }).mockReturnValueOnce(pending.promise)
  render(<CommanderHandoffs {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Ship upgrade/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Resume in Commander' }))
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'other'
  await act(async () => pending.resolve({ page: original }))
  expect(resumeCommanderHandoff).not.toHaveBeenCalled()
})

it('keeps a filtered page and keyboard focus when returning from one handoff', async () => {
  const user = userEvent.setup()
  const remoteProject = 'github:org/other'
  const later = {
    ...original,
    pageId: 'handoff-00000000-0000-4000-8000-000000000002',
    title: 'Persist cursor'
  }
  const memory = api()
  memory.index.mockImplementation(async (_account, filters) => {
    const scoped =
      filters.validHandoffsOnly &&
      filters.order === 'recent' &&
      filters.projectId === remoteProject &&
      filters.q === 'fixtures'
    return {
      pages: scoped && filters.after === 'next-batch' ? [summary(later)] : [summary(original)],
      projects: [remoteProject],
      next: scoped && !filters.after ? 'next-batch' : null
    }
  })
  memory.get.mockResolvedValue({ page: later })
  render(<CommanderHandoffs {...props} />)
  await screen.findByRole('button', { name: /Ship upgrade/ })
  await user.click(screen.getByRole('combobox', { name: 'Project' }))
  await user.click(await screen.findByRole('option', { name: remoteProject }))
  await user.type(screen.getByRole('searchbox'), 'fixtures')
  await user.click(await screen.findByRole('button', { name: 'Next page' }))
  const row = await screen.findByRole('button', { name: /Persist cursor/ })
  expect(memory.get).not.toHaveBeenCalled()
  row.focus()
  await user.keyboard('{Enter}')
  await screen.findByRole('heading', { name: 'Persist cursor' })
  expect(memory.get).toHaveBeenCalledWith(account, later.pageId, 1)
  await user.keyboard('{Escape}')
  const returned = await screen.findByRole('button', { name: /Persist cursor/ })
  expect(returned).toHaveFocus()
  expect(screen.getByRole('searchbox')).toHaveValue('fixtures')
  await user.click(screen.getByRole('button', { name: 'Previous page' }))
  await screen.findByRole('button', { name: /Ship upgrade/ })
})
