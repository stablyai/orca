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

const DAY_MS = 24 * 60 * 60 * 1000

// Use relative dates because the labels under test are relative times.
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

// Include aria-hidden rows behind Radix’s modal menu so assertions can inspect their selection state.
function rowFor(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(title), hidden: true })
}

describe('ArtifactCollection', () => {
  afterEach(cleanup)
  // Restore prototype layout spies or later tests inherit fabricated geometry.
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

  /** Guard clicks from both descendant triggers and React-bubbling portaled menu items so actions cannot select the row behind them. */
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
})
