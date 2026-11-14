// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEmojiPickerPanel } from './WorkspaceEmojiPickerPanel'

afterEach(cleanup)

function searchBox(): HTMLElement {
  return screen.getByPlaceholderText('Search emoji')
}

describe('WorkspaceEmojiPickerPanel', () => {
  it('filters by shortcode and picks the highlighted match on Enter without bubbling', () => {
    const onPick = vi.fn()
    const onParentKeyDown = vi.fn()
    render(
      <div onKeyDown={onParentKeyDown}>
        <WorkspaceEmojiPickerPanel onPick={onPick} />
      </div>
    )

    fireEvent.change(searchBox(), { target: { value: 'tada' } })
    expect(screen.getAllByRole('option')[0].textContent).toContain(':tada:')
    fireEvent.keyDown(searchBox(), { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith('🎉')
    expect(onParentKeyDown).not.toHaveBeenCalled()
  })

  it('shows an empty state when nothing matches', () => {
    render(<WorkspaceEmojiPickerPanel onPick={vi.fn()} />)
    fireEvent.change(searchBox(), { target: { value: 'zzzznotanemoji' } })

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No emoji found')).toBeTruthy()
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'leaves IME-owned Enter to the search input (%o)',
    (imeEvent) => {
      const onPick = vi.fn()
      render(<WorkspaceEmojiPickerPanel onPick={onPick} />)

      fireEvent.change(searchBox(), { target: { value: 'tada' } })
      fireEvent.keyDown(searchBox(), { key: 'Enter', ...imeEvent })
      expect(onPick).not.toHaveBeenCalled()

      fireEvent.keyDown(searchBox(), { key: 'Enter' })
      expect(onPick).toHaveBeenCalledWith('🎉')
    }
  )
})
