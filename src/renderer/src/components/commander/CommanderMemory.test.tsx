// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { Activity } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CommanderMemoryIndexQuery,
  CommanderMemoryRevision,
  CommanderMemoryWrite
} from '../../../../shared/commander/memory-contract'
import { CommanderMemory } from './CommanderMemory'
import { CommanderMemoryPage } from './CommanderMemoryPage'

const state = vi.hoisted(() => ({
  orcaProfileAuthStatus: {
    activeProfileId: 'p',
    state: 'connected',
    cloud: { userId: 'u', activeOrgId: 'org1' }
  },
  activeOrcaProfileId: 'p',
  orcaProfileSwitching: false,
  fetchOrcaProfileAuthStatus: vi.fn()
}))
vi.mock('@/store/index', () => ({
  useAppStore: (select: (store: typeof state) => unknown) => select(state)
}))
vi.mock('./CommanderRecording', () => ({ CommanderRecording: () => null }))
vi.mock('@/components/comment-markdown/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>
}))
const account = { profileId: 'p', userId: 'u', activeOrgId: 'org1' }
const initial: CommanderMemoryRevision = {
  version: 1,
  kind: 'decision',
  title: 'Rollout',
  body: 'Start in staging',
  projectId: 'github:org/api',
  links: [],
  actor: { type: 'commander', id: 'primary' },
  createdBy: { type: 'commander', id: 'primary' },
  createdAt: '2026-01-01T00:00:00Z',
  deleted: false,
  pageId: 'release'
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'org1'
})

it('retains an edit during a concurrent revision and requires explicit rebase before writing', async () => {
  const latest = { ...initial, version: 2, body: 'Agent finished staging' }
  const get = vi
    .fn()
    .mockResolvedValueOnce({ page: initial, history: [initial] })
    .mockResolvedValue({ page: latest, history: [latest, initial] })
  const save = vi
    .fn()
    .mockResolvedValue({ page: { ...latest, version: 3, body: 'Request production approval' } })
  vi.stubGlobal('api', {
    commanderMemory: { get, save, index: async () => ({ pages: [], projects: [], next: null }) }
  })
  const props = {
    account,
    selected: { pageId: 'release', projectId: initial.projectId ?? null, isNew: false },
    onBack: vi.fn(),
    onOpen: vi.fn()
  }
  const view = render(<CommanderMemoryPage {...props} pages={[initial]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit page' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown' }), {
    target: { value: 'Request production approval' }
  })
  view.rerender(<CommanderMemoryPage {...props} pages={[latest]} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save revision' })).toBeDisabled())
  expect(screen.getByRole('textbox', { name: 'Markdown' })).toHaveValue(
    'Request production approval'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Keep my draft against this revision' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        expectedVersion: 2,
        pageId: 'release',
        body: 'Request production approval'
      })
    )
  )
})

it('never renders late list results from a previous organization after switching accounts', async () => {
  const first = Promise.withResolvers<{ pages: CommanderMemoryRevision[] }>()
  const index = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({
      pages: [{ ...initial, title: 'New org decision' }],
      projects: [],
      next: null
    })
  vi.stubGlobal('api', { commanderMemory: { index } })
  const view = render(<CommanderMemory projectId="github:org/api" />)
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'org2'
  view.rerender(<CommanderMemory projectId="github:org/api" />)
  await screen.findByText('New org decision')
  await act(async () => first.resolve({ pages: [{ ...initial, title: 'Private old decision' }] }))
  expect(screen.queryByText('Private old decision')).not.toBeInTheDocument()
  expect(screen.getByText('New org decision')).toBeInTheDocument()
  expect(index).toHaveBeenCalledWith(
    { profileId: 'p', userId: 'u', activeOrgId: 'org2' },
    expect.objectContaining({ projectId: 'github:org/api' })
  )
})

it('shows recording permission for the active organization and changes it only on explicit input', async () => {
  const old = Promise.withResolvers<{ enabled: boolean; lastSyncedAt: null; error: null }>()
  const agentRecovery = vi.fn(async (identity: typeof account, enabled?: boolean) => {
    if (identity.activeOrgId === 'org1') {
      return old.promise
    }
    return { enabled: enabled ?? false, lastSyncedAt: null, error: null }
  })
  vi.stubGlobal('api', {
    commanderMemory: {
      agentRecovery,
      index: async () => ({ pages: [], projects: [], next: null }),
      phoneSharing: async () => false
    }
  })
  const view = render(<CommanderMemory projectId={null} />)
  const findSwitch = () => screen.getByRole('switch', { name: 'Save agent handoffs automatically' })
  expect(findSwitch()).toBeDisabled()
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'org2'
  view.rerender(<CommanderMemory projectId={null} />)
  await waitFor(() => expect(findSwitch()).toBeEnabled())
  await act(async () => old.resolve({ enabled: true, lastSyncedAt: null, error: null }))
  expect(findSwitch()).not.toBeChecked()
  fireEvent.click(findSwitch())
  await waitFor(() => expect(findSwitch()).toBeChecked())
  expect(agentRecovery).toHaveBeenCalledWith({ ...account, activeOrgId: 'org2' }, true)
  expect(agentRecovery).not.toHaveBeenCalledWith(account, true)
})

it('saves trimmed answers with their project and supports versioned edits and removal', async () => {
  let page: CommanderMemoryRevision = {
    ...initial,
    kind: 'guideline',
    title: 'Recurring answer',
    actor: { type: 'human', id: 'u' },
    createdBy: { type: 'human', id: 'u' },
    body: '',
    version: 0
  }
  const save = vi.fn(async (_account: typeof account, write: CommanderMemoryWrite) => {
    page = {
      ...page,
      pageId: write.pageId,
      body: write.deleted ? page.body : write.body,
      deleted: !!write.deleted,
      version: page.version + 1
    }
    return { page }
  })
  vi.stubGlobal('api', {
    commanderMemory: {
      index: async () => ({ pages: page.version ? [page] : [], projects: [], next: null }),
      get: async () => ({ page, history: [page] }),
      save,
      phoneSharing: async () => false
    }
  })
  render(<CommanderMemory projectId="github:org/api" />)
  fireEvent.click(screen.getByRole('button', { name: 'New recurring answer' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Exact question' }), {
    target: { value: ' Run unit tests? ' }
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: ' Yes ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await screen.findByRole('button', { name: 'Edit page' })
  const first = save.mock.calls[0]?.[1]
  expect(first).toMatchObject({
    kind: 'guideline',
    title: 'Recurring answer',
    expectedVersion: 0,
    projectId: 'github:org/api'
  })
  if (!first || first.deleted) {
    throw new Error('Expected an active answer')
  }
  expect(JSON.parse(first.body)).toEqual({ version: 1, question: 'Run unit tests?', answer: 'Yes' })
  fireEvent.click(screen.getByRole('button', { name: 'Edit page' }))
  expect(screen.getByRole('textbox', { name: 'Exact question' })).toHaveValue('Run unit tests?')
  fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), {
    target: { value: 'Use the fast suite' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await screen.findByText('Use the fast suite')
  expect(save).toHaveBeenLastCalledWith(
    account,
    expect.objectContaining({ expectedVersion: 1, pageId: page.pageId })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Delete page' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
  await screen.findByRole('button', { name: 'Restore page' })
  expect(save).toHaveBeenLastCalledWith(
    account,
    expect.objectContaining({ expectedVersion: 2, deleted: true, pageId: page.pageId })
  )
})

it('keeps automatic decision receipts read-only while showing their revision history', async () => {
  const page = { ...initial, recurringAnswerReceipt: true as const }
  vi.stubGlobal('api', {
    commanderMemory: {
      get: async () => ({ page, history: [page] }),
      index: async () => ({ pages: [page], projects: [], next: null })
    }
  })
  render(
    <CommanderMemoryPage
      account={account}
      selected={{ pageId: page.pageId, projectId: page.projectId ?? null, isNew: false }}
      pages={[page]}
      onBack={vi.fn()}
      onOpen={vi.fn()}
    />
  )
  await screen.findByRole('heading', { name: 'Rollout' })
  expect(screen.queryByRole('button', { name: 'Edit page' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Delete page' })).not.toBeInTheDocument()
  expect(screen.getByText('Revision history (1)')).toBeInTheDocument()
})

it('requires confirmed state for writes, reloads a conflicting version and refreshes on return to Memory', async () => {
  let server = { enabled: false, version: 2 }
  const firstRead = Promise.withResolvers<typeof server>()
  const recurringAnswers = vi
    .fn(
      async (identity: typeof account, change?: { enabled: boolean; expectedVersion: number }) => {
        expect(identity).toEqual(account)
        if (change) {
          if (change.expectedVersion !== server.version) {
            throw new Error('Account setting changed')
          }
          server = { enabled: change.enabled, version: server.version + 1 }
        }
        return server
      }
    )
    .mockImplementationOnce(() => firstRead.promise)
  vi.stubGlobal('api', {
    commanderMemory: {
      recurringAnswers,
      index: async () => ({ pages: [], projects: [], next: null }),
      phoneSharing: async () => false
    }
  })
  const memory = (visible: boolean) => (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <CommanderMemory projectId={null} />
    </Activity>
  )
  const view = render(memory(true))
  const toggle = () => screen.getByRole('switch', { name: 'Use recurring answers' })
  expect(toggle()).toBeDisabled()
  expect(toggle()).not.toBeChecked()
  await act(async () => firstRead.resolve(server))
  expect(toggle()).toBeEnabled()
  server = { enabled: true, version: 3 }
  fireEvent.click(toggle())
  await screen.findByRole('alert')
  await waitFor(() => expect(toggle()).toBeChecked())
  expect(recurringAnswers).toHaveBeenCalledWith(account, { enabled: true, expectedVersion: 2 })
  fireEvent.click(toggle())
  await waitFor(() => expect(toggle()).not.toBeChecked())
  expect(recurringAnswers).toHaveBeenCalledWith(account, { enabled: false, expectedVersion: 3 })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  view.rerender(memory(false))
  server = { enabled: true, version: 5 }
  view.rerender(memory(true))
  await waitFor(() => expect(toggle()).toBeChecked())
})

it('keeps recurring answers unavailable until the current organization can be read', async () => {
  const previousOrg = Promise.withResolvers<{ enabled: boolean; version: number }>()
  const recurringAnswers = vi
    .fn()
    .mockReturnValueOnce(previousOrg.promise)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ enabled: false, version: 0 })
  vi.stubGlobal('api', {
    commanderMemory: {
      recurringAnswers,
      index: async () => ({ pages: [], projects: [], next: null }),
      phoneSharing: async () => false
    }
  })
  const view = render(<CommanderMemory projectId={null} />)
  state.orcaProfileAuthStatus.cloud.activeOrgId = 'org2'
  view.rerender(<CommanderMemory projectId={null} />)
  const retry = await screen.findByRole('button', { name: 'Retry' })
  await act(async () => previousOrg.resolve({ enabled: true, version: 7 }))
  const toggle = screen.getByRole('switch', { name: 'Use recurring answers' })
  expect(toggle).not.toBeChecked()
  expect(toggle).toBeDisabled()
  fireEvent.click(retry)
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).not.toBeChecked()
  expect(recurringAnswers).toHaveBeenLastCalledWith({ ...account, activeOrgId: 'org2' })
})

it('keeps a server-side body search on its first page when a previous page turn arrives late', async () => {
  const late = Promise.withResolvers<{
    pages: CommanderMemoryRevision[]
    projects: string[]
    next: null
  }>()
  const index = vi.fn(async (_account: typeof account, query: CommanderMemoryIndexQuery) => {
    if (query.after) {
      return late.promise
    }
    if (query.q === 'unique body fragment') {
      return { pages: [{ ...initial, title: 'Historical decision' }], projects: [], next: null }
    }
    return { pages: [initial], projects: [], next: 'more' }
  })
  vi.stubGlobal('api', { commanderMemory: { index, phoneSharing: async () => false } })
  render(<CommanderMemory projectId="github:org/api" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }))
  await waitFor(() =>
    expect(index).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ after: 'more', projectId: 'github:org/api' })
    )
  )
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory pages' }), {
    target: { value: 'unique body fragment' }
  })
  await screen.findByText('Historical decision')
  await act(async () =>
    late.resolve({
      pages: [{ ...initial, title: 'Superseded search result' }],
      projects: [],
      next: null
    })
  )
  expect(screen.queryByText('Superseded search result')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Previous page' })).not.toBeInTheDocument()
  expect(screen.getByText('Historical decision')).toBeInTheDocument()
})

it('opens a linked guideline outside the displayed decision batch', async () => {
  const receipt = { ...initial, pageId: 'receipt', title: 'Recorded answer', links: ['rule'] }
  const rule = { ...initial, kind: 'guideline' as const, pageId: 'rule', title: 'Release policy' }
  const index = vi.fn(async (_account: typeof account, query: CommanderMemoryIndexQuery) => ({
    pages: query.ids ? [receipt, rule].filter((p) => query.ids?.includes(p.pageId)) : [receipt],
    projects: [],
    next: null
  }))
  const get = vi.fn(async (_account: typeof account, id: string) => ({
    page: id === 'rule' ? rule : receipt,
    history: []
  }))
  vi.stubGlobal('api', { commanderMemory: { index, get, phoneSharing: async () => false } })
  render(<CommanderMemory projectId={null} />)
  fireEvent.click(await screen.findByText('Recorded answer'))
  fireEvent.click(await screen.findByRole('button', { name: 'Release policy' }))
  await screen.findByRole('heading', { name: 'Release policy' })
  expect(get).toHaveBeenCalledWith(account, 'rule')
})

it('continues past excluded link choices and searches across the account without losing the draft', async () => {
  const target = {
    ...initial,
    pageId: 'docs',
    projectId: 'github:org/other',
    title: 'API documentation'
  }
  const index = vi.fn(async (_account: typeof account, query: CommanderMemoryIndexQuery) => {
    if (query.ids) {
      return {
        pages: [initial, target].filter((page) => query.ids?.includes(page.pageId)),
        projects: [],
        next: null
      }
    }
    if (query.q === 'documentation') {
      return { pages: [target], projects: [], next: null }
    }
    return { pages: [initial], projects: [], next: 'another-page' }
  })
  const save = vi.fn(async (_account: typeof account, write: CommanderMemoryWrite) => ({
    page: { ...initial, ...write, version: 2 }
  }))
  vi.stubGlobal('api', {
    commanderMemory: { index, get: async () => ({ page: initial, history: [] }), save }
  })
  render(
    <CommanderMemoryPage
      account={account}
      selected={{ pageId: initial.pageId, projectId: initial.projectId ?? null, isNew: false }}
      pages={[initial]}
      onBack={vi.fn()}
      onOpen={vi.fn()}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Edit page' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Markdown' }), {
    target: { value: 'Keep draft notes' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Link a page' }))
  await screen.findByRole('button', { name: 'Next page' })
  expect(screen.queryByText('No matching pages.')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory pages' }), {
    target: { value: 'documentation' }
  })
  fireEvent.click(await screen.findByRole('button', { name: /API documentation/ }))
  expect(screen.getByRole('textbox', { name: 'Markdown' })).toHaveValue('Keep draft notes')
  fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        pageId: 'release',
        links: ['docs'],
        body: 'Keep draft notes'
      })
    )
  )
})
