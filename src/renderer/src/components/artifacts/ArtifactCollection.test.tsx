// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'

vi.mock('./ArtifactPreview', () => ({
  ArtifactPreview: ({ shareUrl }: { shareUrl: string }) => <div>{`Preview ${shareUrl}`}</div>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ArtifactCollection } from './ArtifactCollection'
import { LIST_TABLE_CONTAINER_CLASS } from '@/lib/list-table-layout'

const DAY_MS = 24 * 60 * 60 * 1000

// Why: relative to now — the labels under test are relative times, so fixed dates would rot.
function artifact(slug: string, title: string): ArtifactListItem {
  const createdAt = new Date(Date.now() - DAY_MS).toISOString()
  return {
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: `${slug}.html`,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      byteSize: 1200,
      deletedAt: null
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`
  }
}

describe('ArtifactCollection', () => {
  afterEach(cleanup)

  function renderCollection(
    items: ArtifactListItem[],
    selectArtifact = vi.fn()
  ): { container: HTMLElement; selectArtifact: ReturnType<typeof vi.fn> } {
    const { container } = render(
      <TooltipProvider>
        <ArtifactCollection
          artifacts={items}
          deletingId={null}
          selectedSlug={items[0]?.artifact.slug ?? null}
          selectArtifact={selectArtifact}
          deleteArtifact={vi.fn()}
          hasMore={false}
          loadingMore={false}
          loadMore={vi.fn()}
          onRefresh={vi.fn()}
          isRefreshing={false}
        />
      </TooltipProvider>
    )
    return { container, selectArtifact }
  }

  it('renders a full-width table list without an inline preview', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    const { container, selectArtifact } = renderCollection(items)

    const table = container.querySelector(`.${LIST_TABLE_CONTAINER_CLASS.split(' ')[0]}`)
    expect(table).toHaveClass('rounded-md', 'border')
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Type')).toBeInTheDocument()
    expect(screen.queryByText(/Preview https:\/\//)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Second artifact/ }))
    expect(selectArtifact).toHaveBeenCalledWith('second')
  })

  it('highlights only the selected row', () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    renderCollection(items)

    const first = screen.getByRole('button', { name: /First artifact/ })
    const second = screen.getByRole('button', { name: /Second artifact/ })
    expect(first).toHaveAttribute('data-current', 'true')
    expect(second).not.toHaveAttribute('data-current')
  })

  it('commits selection on Enter from the focused row', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    const { selectArtifact } = renderCollection(items)
    const second = screen.getByRole('button', { name: /Second artifact/ })

    second.focus()
    await userEvent.keyboard('{Enter}')
    expect(selectArtifact).toHaveBeenCalledWith('second')
  })

  it('filters the list by name', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    renderCollection(items)

    await userEvent.type(screen.getByPlaceholderText('Search...'), 'second')
    expect(screen.getByRole('button', { name: /Second artifact/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /First artifact/ })).not.toBeInTheDocument()

    await userEvent.clear(screen.getByPlaceholderText('Search...'))
    await userEvent.type(screen.getByPlaceholderText('Search...'), 'nothing')
    expect(screen.queryByRole('button', { name: /Second artifact/ })).not.toBeInTheDocument()
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })

  it('shows compact type, size, and expiry in the row', () => {
    const items = [artifact('first', 'First artifact')]
    renderCollection(items)

    expect(screen.getByText('HTML')).toBeInTheDocument()
    expect(screen.getByText('1.2 KB')).toBeInTheDocument()
    expect(screen.getByText(/in \d+ days/)).toBeInTheDocument()
    expect(screen.queryByText('https://share.onorca.dev/a/first')).not.toBeInTheDocument()
  })
})
