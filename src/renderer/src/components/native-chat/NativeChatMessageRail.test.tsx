// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatMessageRail } from './NativeChatMessageRail'

afterEach(cleanup)

const items = Array.from({ length: 3 }, (_, index) => ({
  id: `prompt-${index}`,
  text: `Prompt ${index}`,
  slotIndex: index,
  hasImages: false
}))

describe('message rail interaction', () => {
  it('opens from the keyboard, reaches prompts, jumps, and restores focus', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    render(
      <NativeChatMessageRail
        rail={{ items, ticks: items, activeId: items[1].id, visible: true }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={select}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    await user.tab()
    expect(document.activeElement).toBe(trigger)
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Prompt 0' }))
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Prompt 1' }))
    await user.keyboard('{Enter}')
    expect(select).toHaveBeenCalledWith(items[1])
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.keyboard('{Enter}')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps focus in the transcript while a hover preview opens and closes', async () => {
    render(
      <>
        <input aria-label="Composer" />
        <NativeChatMessageRail
          rail={{ items, ticks: items, activeId: null, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      </>
    )
    const composer = screen.getByRole('textbox')
    composer.focus()
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    await screen.findByRole('dialog')
    expect(document.activeElement).toBe(composer)
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(composer)
  })

  it.each([
    [0, 7],
    [1, 112],
    [2, 2800]
  ])('forwards wheel delta mode %i', (deltaMode, expected) => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { value: 400 })
    render(
      <NativeChatMessageRail
        rail={{ items, ticks: items, activeId: null, visible: true }}
        scrollRef={{ current: element }}
        onSelect={vi.fn()}
      />
    )
    fireEvent.wheel(screen.getByRole('button', { name: 'Your messages' }), { deltaY: 7, deltaMode })
    expect(element.scrollTop).toBe(expected)
  })
})
