// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LargeDiffLoadPrompt } from './LargeDiffLoadPrompt'

const KNOWN_LARGE_COPY = 'Large diffs are not rendered by default.'
const UNKNOWN_SIZE_COPY = "This diff's size isn't known yet, so it loads on request."

describe('LargeDiffLoadPrompt', () => {
  afterEach(cleanup)

  it('loads only from the explicit action', () => {
    const onLoad = vi.fn()
    const onParentClick = vi.fn()

    render(
      <div onClick={onParentClick}>
        <LargeDiffLoadPrompt onLoad={onLoad} />
      </div>
    )

    screen.getByText(KNOWN_LARGE_COPY)
    fireEvent.click(screen.getByRole('button', { name: 'Load diff' }))

    expect(onLoad).toHaveBeenCalledOnce()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('calls a row large only when its counts say so', () => {
    render(<LargeDiffLoadPrompt onLoad={vi.fn()} sizeUnknown={false} />)

    screen.getByText(KNOWN_LARGE_COPY)
    expect(screen.queryByText(UNKNOWN_SIZE_COPY)).toBeNull()
  })

  it('does not claim an uncounted row is large', () => {
    // A lone tracked binary (resources/build/icon.icns) is deferred with no
    // counts at all; it may be 4 KB.
    render(<LargeDiffLoadPrompt onLoad={vi.fn()} sizeUnknown />)

    screen.getByText(UNKNOWN_SIZE_COPY)
    expect(screen.queryByText(KNOWN_LARGE_COPY)).toBeNull()
  })
})
