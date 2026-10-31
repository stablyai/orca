// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEmojiPickerPanel } from './WorkspaceEmojiPickerPanel'

afterEach(cleanup)

describe('WorkspaceEmojiPickerPanel', () => {
  it('shows curated emoji before searching and picks on click', () => {
    const onPick = vi.fn()
    render(<WorkspaceEmojiPickerPanel onPick={onPick} />)

    expect(screen.getAllByRole('button')).toHaveLength(48)
    fireEvent.click(screen.getByRole('button', { name: ':bug:' }))
    expect(onPick).toHaveBeenCalledWith('🐛')
  })

  it('filters by shortcode and picks the first match on Enter without bubbling', () => {
    const onPick = vi.fn()
    const onParentKeyDown = vi.fn()
    render(
      <div onKeyDown={onParentKeyDown}>
        <WorkspaceEmojiPickerPanel onPick={onPick} />
      </div>
    )
    const search = screen.getByRole('textbox', { name: 'Search emoji' })

    fireEvent.change(search, { target: { value: 'tada' } })
    expect(screen.getAllByRole('button')[0].getAttribute('aria-label')).toBe(':tada:')
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith('🎉')
    expect(onParentKeyDown).not.toHaveBeenCalled()
  })

  it('shows an empty state when nothing matches', () => {
    render(<WorkspaceEmojiPickerPanel onPick={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji' }), {
      target: { value: 'zzzznotanemoji' }
    })

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('No emoji found')).toBeTruthy()
  })

  it('moves focus through the grid with arrow keys and back to search from the top row', () => {
    render(<WorkspaceEmojiPickerPanel onPick={vi.fn()} />)
    const search = screen.getByRole('textbox', { name: 'Search emoji' })
    const cells = screen.getAllByRole('button')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cells[0])
    fireEvent.keyDown(cells[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cells[8])
    fireEvent.keyDown(cells[8], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cells[9])
    fireEvent.keyDown(cells[9], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cells[1])
    fireEvent.keyDown(cells[1], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search)
  })
})
