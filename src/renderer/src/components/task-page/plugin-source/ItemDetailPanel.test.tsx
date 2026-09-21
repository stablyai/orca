// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { TaskPagePluginSourceContent } from './Content'

const BOARDS = { pluginKey: 'nssf.azure-boards', sourceId: 'boards' }

const ITEM: PluginTaskItem = {
  id: 'nssf/proj/41',
  key: 'AB-41',
  title: 'Ship the detail panel',
  state: { name: 'Active', category: 'in-progress' },
  assignee: { id: 'u1', displayName: 'David Mugisha', avatarUrl: null },
  url: 'https://dev.azure.com/nssf/proj/_workitems/edit/41',
  updatedAt: null,
  scopeId: null,
  labels: ['platform']
}

const STATUS = {
  connected: true,
  accountLabel: 'Boards',
  notice: null,
  supports: {
    create: false,
    comment: false,
    transition: false,
    assign: false,
    editTitle: false,
    editDescription: false
  }
}

const THREE_HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()

const COMMENT = {
  id: 'c1',
  author: { id: 'u2', displayName: 'Amelia Kato', avatarUrl: null },
  body: 'Looks **good** to me.',
  bodyFormat: 'markdown',
  createdAt: THREE_HOURS_AGO
}

const POSTED = {
  id: 'c2',
  author: { id: 'u3', displayName: 'Isaac Obella', avatarUrl: null },
  body: 'Shipping today',
  bodyFormat: 'text',
  createdAt: new Date().toISOString()
}

type SourceAnswers = {
  item?: PluginTaskItem
  detail?: unknown
  comments?: unknown
  supportsComment?: boolean
  addComment?: () => unknown
}

/** Routes by method so the detail fetch and the comment fetch can fail or
 *  succeed independently, the way a real source answers them. */
function stubSource(answers: SourceAnswers = {}): ReturnType<typeof vi.fn> {
  const item = answers.item ?? ITEM
  const invoke = vi.fn().mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status') {
      return {
        ok: true,
        data: {
          ...STATUS,
          supports: { ...STATUS.supports, comment: answers.supportsComment ?? false }
        }
      }
    }
    if (args.method === 'listScopes') {
      return { ok: true, data: [] }
    }
    if (args.method === 'listItems') {
      return { ok: true, data: { items: [item], nextCursor: null } }
    }
    if (args.method === 'getItem') {
      return answers.detail ?? { ok: true, data: { ...item, descriptionFormat: 'text' } }
    }
    if (args.method === 'addComment') {
      return answers.addComment ? answers.addComment() : { ok: true, data: POSTED }
    }
    return answers.comments ?? { ok: true, data: [] }
  })
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: {
        plugins: { invokeTaskSource: invoke },
        shell: { openUrl: vi.fn() },
        ui: { writeClipboardText: vi.fn() }
      }
    })
  )
  return invoke
}

function selectBoards(): void {
  useAppStore.setState({ pluginTaskSources: [{ ...BOARDS, title: 'Azure Boards' }] })
  useAppStore.getState().selectPluginTaskSource(BOARDS)
}

async function openPanel(
  answers: SourceAnswers = {}
): Promise<{ invoke: ReturnType<typeof vi.fn>; user: ReturnType<typeof userEvent.setup> }> {
  const user = userEvent.setup()
  const invoke = stubSource(answers)
  selectBoards()
  render(
    <TooltipProvider>
      <TaskPagePluginSourceContent />
    </TooltipProvider>
  )
  const row = answers.item ?? ITEM
  await user.click(await screen.findByRole('button', { name: `${row.key} ${row.title}` }))
  await screen.findByRole('dialog')
  return { invoke, user }
}

/** The markdown renderer is a lazy chunk; its first import can outrun the
 *  default 1s query timeout when the whole suite runs in parallel. */
function findMarkdownText(text: string): Promise<HTMLElement> {
  return screen.findByText(text, {}, { timeout: 10_000 })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('TaskPage contributed source detail panel', () => {
  it('opens on a row click and fetches the clicked item detail', async () => {
    const { invoke } = await openPanel()

    expect(
      await screen.findByRole('heading', { name: 'Ship the detail panel' })
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith({
      ...BOARDS,
      method: 'getItem',
      params: { id: 'nssf/proj/41' }
    })
    expect(invoke).toHaveBeenCalledWith({
      ...BOARDS,
      method: 'listComments',
      params: { id: 'nssf/proj/41' }
    })
  })

  it('renders a markdown description through the markdown component', async () => {
    await openPanel({
      detail: {
        ok: true,
        data: { ...ITEM, description: 'Ship it **now**', descriptionFormat: 'markdown' }
      }
    })

    expect(await findMarkdownText('now')).toBeInTheDocument()
    expect(screen.queryByText('Ship it **now**')).not.toBeInTheDocument()
  })

  it('renders a text description as literal characters, never as markdown', async () => {
    await openPanel({
      detail: {
        ok: true,
        data: { ...ITEM, description: 'Ship it **now**', descriptionFormat: 'text' }
      }
    })

    expect(await screen.findByText('Ship it **now**')).toBeInTheDocument()
    expect(document.querySelector('strong')).toBeNull()
  })

  it('shows the getItem failure instead of an empty body', async () => {
    await openPanel({
      detail: { ok: false, code: 'not_found', message: 'Work item 41 is gone.' }
    })

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((alert) => alert.textContent === 'Work item 41 is gone.')).toBe(true)
    expect(screen.queryByText('No description provided.')).not.toBeInTheDocument()
  })

  it('keeps the loaded description visible when the comments fail', async () => {
    await openPanel({
      detail: {
        ok: true,
        data: { ...ITEM, description: 'Ship it **now**', descriptionFormat: 'markdown' }
      },
      comments: { ok: false, code: 'unavailable', message: 'Comments are unavailable.' }
    })

    expect(await screen.findByText('Comments are unavailable.')).toBeInTheDocument()
    expect(await findMarkdownText('now')).toBeInTheDocument()
  })

  it('renders each comment with its author and relative time', async () => {
    await openPanel({ comments: { ok: true, data: [COMMENT] } })

    expect(await screen.findByText('Amelia Kato')).toBeInTheDocument()
    expect(screen.getByText('3 hours ago')).toBeInTheDocument()
    expect(await findMarkdownText('good')).toBeInTheDocument()
  })

  it('offers the open and copy actions for an item that carries a url', async () => {
    await openPanel()

    expect(await screen.findByRole('button', { name: 'Open in Azure Boards' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument()
  })

  it('offers no open action for an item the source gave no url', async () => {
    await openPanel({ item: { ...ITEM, url: null } })

    expect(await screen.findByRole('button', { name: 'Copy key' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open in Azure Boards' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy URL' })).not.toBeInTheDocument()
  })

  it('shows a composer only for a source that declared supports.comment', async () => {
    await openPanel({ supportsComment: true })

    expect(await screen.findByRole('textbox', { name: 'Comment body' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
  })

  it('shows no composer for a source that cannot post', async () => {
    await openPanel()

    // Waits for the same probe that would have enabled the composer, so the
    // absence below is a decision rather than a race.
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Comment body' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument()
  })

  it('posts the typed body through addComment with the item id', async () => {
    const { invoke, user } = await openPanel({ supportsComment: true })

    await user.type(await screen.findByRole('textbox', { name: 'Comment body' }), 'Shipping today')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        ...BOARDS,
        method: 'addComment',
        params: { id: 'nssf/proj/41', body: 'Shipping today' }
      })
    })
  })

  it('shows the posted comment and clears the draft', async () => {
    const { user } = await openPanel({ supportsComment: true })

    const field = await screen.findByRole('textbox', { name: 'Comment body' })
    await user.type(field, 'Shipping today')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByText('Isaac Obella')).toBeInTheDocument()
    expect(field).toHaveValue('')
  })

  it('keeps the typed body when the post fails, and shows the error', async () => {
    const { user } = await openPanel({
      supportsComment: true,
      addComment: () => ({ ok: false, code: 'unavailable', message: 'Azure rejected the comment.' })
    })

    const field = await screen.findByRole('textbox', { name: 'Comment body' })
    await user.type(field, 'Shipping today')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByText('Azure rejected the comment.')).toBeInTheDocument()
    expect(field).toHaveValue('Shipping today')
  })

  it('does not post twice while one post is in flight', async () => {
    let settle: (result: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      settle = resolve
    })
    const { invoke, user } = await openPanel({
      supportsComment: true,
      addComment: () => pending
    })

    await user.type(await screen.findByRole('textbox', { name: 'Comment body' }), 'Shipping today')
    const submit = screen.getByRole('button', { name: 'Comment' })
    await user.click(submit)
    await user.click(submit)

    const posts = invoke.mock.calls.filter((call) => call[0].method === 'addComment')
    expect(posts).toHaveLength(1)

    settle({ ok: true, data: POSTED })
    expect(await screen.findByText('Isaac Obella')).toBeInTheDocument()
  })

  it('does not post a whitespace-only body', async () => {
    const { invoke, user } = await openPanel({ supportsComment: true })

    await user.type(await screen.findByRole('textbox', { name: 'Comment body' }), '   ')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(invoke.mock.calls.filter((call) => call[0].method === 'addComment')).toHaveLength(0)
  })

  it('prefills the composer with an attributed quote when replying', async () => {
    const { user } = await openPanel({
      supportsComment: true,
      comments: { ok: true, data: [COMMENT] }
    })

    await user.click(await screen.findByRole('button', { name: 'Reply to Amelia Kato' }))

    expect(screen.getByRole('textbox', { name: 'Comment body' })).toHaveValue(
      '> **Amelia Kato wrote:**\n>\n> Looks **good** to me.\n\n'
    )
  })

  it('returns to the list when the panel is closed', async () => {
    const { user } = await openPanel()

    await user.click(await screen.findByRole('button', { name: 'Close task details' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: `${ITEM.key} ${ITEM.title}` })).toBeInTheDocument()
  })
})
