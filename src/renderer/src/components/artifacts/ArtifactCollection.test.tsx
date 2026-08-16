// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'

vi.mock('./ArtifactPreview', () => ({
  ArtifactPreview: ({ shareUrl }: { shareUrl: string }) => <div>{`Preview ${shareUrl}`}</div>
}))

vi.mock('./ArtifactActions', () => ({
  ArtifactActions: () => <div>Artifact actions</div>
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ArtifactCollection } from './ArtifactCollection'

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
          selectedArtifact={items[0]}
          selectArtifact={selectArtifact}
          deleteArtifact={vi.fn()}
          hasMore={false}
          loadingMore={false}
          loadMore={vi.fn()}
        />
      </TooltipProvider>
    )
    return { container, selectArtifact }
  }

  it('keeps the artifact list beside a contained preview', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    const { container, selectArtifact } = renderCollection(items)

    const collection = container.firstElementChild
    // Why: full-bleed split — no card frame around the panes.
    expect(collection).toHaveClass('lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]')
    expect(collection).not.toHaveClass('rounded-md')
    expect(collection?.children[1]?.tagName).toBe('SECTION')
    expect(screen.getByText('Preview https://share.onorca.dev/a/first')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('option', { name: /Second artifact/ }))
    expect(selectArtifact).toHaveBeenCalledWith('second')
  })

  it('exposes the list as a single-tab-stop listbox', () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    renderCollection(items)

    expect(screen.getByRole('listbox', { name: 'Shared artifacts' })).toBeInTheDocument()
    const [first, second] = screen.getAllByRole('option')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(first).toHaveAttribute('aria-current', 'page')
    expect(first).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('aria-selected', 'false')
    expect(second).toHaveAttribute('tabindex', '-1')
  })

  it('moves focus with arrows and commits selection on Enter', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    const { selectArtifact } = renderCollection(items)
    const [first, second] = screen.getAllByRole('option')

    first.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(second).toHaveFocus()
    // Why: arrows must not commit — each selection reloads the preview webview.
    expect(selectArtifact).not.toHaveBeenCalled()

    await userEvent.keyboard('{Enter}')
    expect(selectArtifact).toHaveBeenCalledWith('second')
  })

  it('filters the list by name and keeps the preview mounted', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    renderCollection(items)

    await userEvent.type(screen.getByPlaceholderText('Search artifacts'), 'second')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Second artifact/ })).toBeInTheDocument()
    expect(screen.getByText('Preview https://share.onorca.dev/a/first')).toBeInTheDocument()

    await userEvent.clear(screen.getByPlaceholderText('Search artifacts'))
    await userEvent.type(screen.getByPlaceholderText('Search artifacts'), 'nothing')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })

  it('shows the share url and expiry instead of repeating the row metadata', () => {
    const items = [artifact('first', 'First artifact')]
    renderCollection(items)

    expect(screen.getByText('https://share.onorca.dev/a/first')).toBeInTheDocument()
    expect(screen.getByText(/Link expires/)).toBeInTheDocument()
  })
})
