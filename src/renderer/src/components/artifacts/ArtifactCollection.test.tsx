// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
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

/** Selection held in state, so whether a click selected is readable off the row's own wash. */
function SelectingCollection({ items }: { items: ArtifactListItem[] }): React.JSX.Element {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  return (
    <ArtifactCollection
      artifacts={items}
      deletingId={null}
      selectedSlug={selectedSlug}
      selectArtifact={setSelectedSlug}
      deleteArtifact={vi.fn()}
      hasMore={false}
      loadingMore={false}
      loadMore={vi.fn()}
      onRefresh={vi.fn()}
      isRefreshing={false}
    />
  )
}

// `hidden`, because a modal Radix menu marks the rest of the tree aria-hidden while it is open —
// and the row behind that menu is exactly what these assertions have to read.
function rowFor(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(title), hidden: true })
}

describe('ArtifactCollection', () => {
  afterEach(cleanup)
  // Why: the viewport stub spies on HTMLElement.prototype, so an unrestored one fabricates
  // layout for every later test in the run.
  afterEach(() => vi.restoreAllMocks())

  function renderCollection(
    items: ArtifactListItem[],
    selectArtifact = vi.fn(),
    hasMore = false
  ): { container: HTMLElement; selectArtifact: ReturnType<typeof vi.fn> } {
    const { container } = render(
      <TooltipProvider>
        <ArtifactCollection
          artifacts={items}
          deletingId={null}
          selectedSlug={items[0]?.artifact.slug ?? null}
          selectArtifact={selectArtifact}
          deleteArtifact={vi.fn()}
          hasMore={hasMore}
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

  /**
   * Both of the row's menu escapes at once. The actions trigger is a DOM descendant of the row, and
   * Radix portals the open menu out of it but React still bubbles its clicks back through the row —
   * so without either guard the detail drawer opens behind every menu interaction.
   */
  it('runs a row menu action without selecting the artifact behind the menu', async () => {
    const user = userEvent.setup()
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    render(
      <TooltipProvider>
        <SelectingCollection items={items} />
      </TooltipProvider>
    )

    // Positive control: a click on the row body does select, so the negatives below are not vacuous.
    await user.click(rowFor('First artifact'))
    expect(rowFor('First artifact')).toHaveAttribute('data-current', 'true')

    const trigger = within(rowFor('Second artifact')).getByRole('button', {
      name: 'Artifact actions'
    })
    await user.click(trigger)
    // Radix mounts menu content only while the menu is open, so a match here is the menu opening.
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument()
    expect(rowFor('Second artifact')).not.toHaveAttribute('data-current')

    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(rowFor('Second artifact')).not.toHaveAttribute('data-current')
    expect(rowFor('First artifact')).toHaveAttribute('data-current', 'true')
  })

  // Why past 50: below the windowing threshold every row is in the DOM, so nothing has to be
  // announced — the set size only has to be right once the rows are windowed.
  const PAGED_ITEM_COUNT = 60

  function pagedItems(): ArtifactListItem[] {
    return Array.from({ length: PAGED_ITEM_COUNT }, (_, index) =>
      artifact(`slug-${index}`, `Artifact ${index}`)
    )
  }

  // Why: happy-dom has no layout, and the virtualizer sizes its window from the scroller's
  // offsetHeight — left at 0 it mounts no rows at all and the assertions below would be vacuous.
  function stubScrollerViewport(): void {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('overflow-auto') ? 600 : 53
      }
    )
  }

  function announcedSetSizes(container: HTMLElement): string[] {
    const wrappers = Array.from(container.querySelectorAll('[data-index]'))
    expect(wrappers.length).toBeGreaterThan(0)
    // The window is a strict subset, so a set size read off the DOM could not reach the real total.
    expect(wrappers.length).toBeLessThan(PAGED_ITEM_COUNT)
    return wrappers.map((wrapper) => wrapper.getAttribute('aria-setsize') ?? 'missing')
  }

  it('announces an unknown set size while a further page is loadable', () => {
    stubScrollerViewport()
    const { container } = renderCollection(pagedItems(), vi.fn(), true)

    // The button is the contradiction: a concrete set size here would claim these are all of them.
    expect(screen.getByRole('button', { name: /Load more/ })).toBeInTheDocument()
    const sizes = announcedSetSizes(container)
    expect(sizes).toEqual(sizes.map(() => '-1'))
  })

  it('announces the real row count once the cursor is exhausted', () => {
    stubScrollerViewport()
    const { container } = renderCollection(pagedItems())

    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
    const sizes = announcedSetSizes(container)
    expect(sizes).toEqual(sizes.map(() => String(PAGED_ITEM_COUNT)))
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
