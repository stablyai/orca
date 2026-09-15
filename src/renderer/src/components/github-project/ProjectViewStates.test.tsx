// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectItemsEmptyState } from './ProjectViewStates'

afterEach(cleanup)

const FILTERED_COPY = "No items match this view's filter."

const UNFILTERED_COPY = 'This view has no items yet.'

const TRANSIENCE_HINT = 'Recently added items can take a while to appear.'

describe('ProjectItemsEmptyState', () => {
  it('blames the filter only when the view actually has one', () => {
    render(<ProjectItemsEmptyState filter="status:Todo" />)
    expect(screen.getByText(FILTERED_COPY)).toBeTruthy()
    expect(screen.queryByText(UNFILTERED_COPY)).toBeNull()
  })

  // #12648: an unfiltered board that momentarily reads back empty must not be
  // reported as a filter miss — that reads as data loss.
  it.each(['', '   ', '\n\t'])('reports an unfiltered view as empty for filter %j', (filter) => {
    render(<ProjectItemsEmptyState filter={filter} />)
    expect(screen.getByText(UNFILTERED_COPY)).toBeTruthy()
    expect(screen.getByText(TRANSIENCE_HINT)).toBeTruthy()
    expect(screen.queryByText(FILTERED_COPY)).toBeNull()
  })
})
