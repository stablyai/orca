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

import { ArtifactCollection } from './ArtifactCollection'

function artifact(slug: string, title: string): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: `${slug}.html`,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:00.000Z',
      expiresAt: '2026-09-07T12:00:00.000Z',
      byteSize: 1200,
      deletedAt: null
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`
  }
}

describe('ArtifactCollection', () => {
  afterEach(cleanup)

  it('keeps the artifact list beside a contained preview', async () => {
    const items = [artifact('first', 'First artifact'), artifact('second', 'Second artifact')]
    const selectArtifact = vi.fn()
    const { container } = render(
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
    )

    const collection = container.firstElementChild
    expect(collection).toHaveClass('grid-cols-[16rem_minmax(0,1fr)]')
    expect(collection?.children[0]?.tagName).toBe('ASIDE')
    expect(collection?.children[1]?.tagName).toBe('SECTION')
    expect(screen.getByText('Preview https://share.onorca.dev/a/first')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Second artifact/ }))
    expect(selectArtifact).toHaveBeenCalledWith('second')
  })
})
