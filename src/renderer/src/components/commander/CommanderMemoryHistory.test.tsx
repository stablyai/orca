// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommanderMemoryRevision } from '../../../../shared/commander/memory-contract'
import { MemoryHistory } from './CommanderMemoryHistory'
import { CommanderMemoryConflict } from './CommanderMemoryConflict'

vi.mock('@/components/comment-markdown/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>
}))
const account = { profileId: 'personal', userId: 'owner', activeOrgId: null }
const revision: CommanderMemoryRevision = {
  pageId: 'release',
  title: 'Deploy',
  body: 'Revision 2 Markdown',
  version: 2,
  kind: 'note',
  projectId: 'api',
  actor: { type: 'agent', id: 'build' },
  createdBy: { type: 'human', id: 'owner' },
  createdAt: '2026-01-10T00:00:00Z',
  deleted: false,
  links: ['unchanged', 'local-removal', 'remote-addition']
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('shows the remote links and rebases only the link changes made by the editor', () => {
  const onRebase = vi.fn()
  render(
    <CommanderMemoryConflict
      page={revision}
      pages={[{ ...revision, pageId: 'remote-addition', title: 'QA sign-off' }]}
      baseLinks={['unchanged', 'local-removal', 'remote-removal']}
      draftLinks={['unchanged', 'remote-removal', 'local-addition']}
      onRebase={onRebase}
    />
  )
  expect(screen.getByText('QA sign-off', { exact: false })).toHaveTextContent('remote-addition')
  fireEvent.click(screen.getByRole('button', { name: 'Keep my draft against this revision' }))
  expect(onRebase).toHaveBeenCalledWith(['unchanged', 'remote-addition', 'local-addition'])
})

it('loads older revisions on demand and mounts Markdown only for the opened entry', async () => {
  const prior = { ...revision, version: 1, title: 'Original', body: 'Revision 1 Markdown' }
  const get = vi
    .fn()
    .mockResolvedValue({ page: revision, history: [prior], nextBeforeVersion: null })
  vi.stubGlobal('api', { commanderMemory: { get } })
  render(
    <MemoryHistory history={[revision]} account={account} initialCursor={2} onRefresh={vi.fn()} />
  )
  expect(screen.queryByText('Revision 2 Markdown')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText(/Revision history/))
  fireEvent.click(await screen.findByRole('button', { name: 'Load older revisions' }))
  const oldSummary = await screen.findByText(/Original/)
  expect(get).toHaveBeenCalledWith(account, 'release', 2)
  expect(screen.queryByText('Revision 1 Markdown')).not.toBeInTheDocument()
  fireEvent.click(oldSummary)
  expect(await screen.findByText('Revision 1 Markdown')).toBeVisible()
  expect(screen.queryByText('Revision 2 Markdown')).not.toBeInTheDocument()
  fireEvent.click(oldSummary)
  await waitFor(() => expect(screen.queryByText('Revision 1 Markdown')).not.toBeInTheDocument())
})
