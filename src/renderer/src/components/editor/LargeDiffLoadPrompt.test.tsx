// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LargeDiffLoadPrompt } from './LargeDiffLoadPrompt'

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

    screen.getByText('Large diffs are not rendered by default.')
    fireEvent.click(screen.getByRole('button', { name: 'Load diff' }))

    expect(onLoad).toHaveBeenCalledOnce()
    expect(onParentClick).not.toHaveBeenCalled()
  })
})
