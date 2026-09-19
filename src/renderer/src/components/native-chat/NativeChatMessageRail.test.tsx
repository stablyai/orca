// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatMessageRail } from './NativeChatMessageRail'

afterEach(cleanup)

const items = Array.from({ length: 3 }, (_, index) => ({
  id: `prompt-${index}`,
  text: `Prompt ${index}`,
  slotIndex: index,
  hasImages: false
}))
const overflowItems = Array.from({ length: 20 }, (_, index) => ({
  id: `overflow-prompt-${index}`,
  text: `Overflow prompt ${index}`,
  slotIndex: index,
  hasImages: false
}))

function retainClosingPopover(): ReturnType<typeof vi.spyOn> {
  const getStyle = window.getComputedStyle.bind(window)
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element, ...args) => {
    const style = getStyle(element, ...args)
    if (element.getAttribute('data-slot') !== 'popover-content') {
      return style
    }
    return new Proxy(style, {
      get: (target, property) =>
        property === 'animationName'
          ? element.getAttribute('data-state') === 'closed'
            ? 'exit'
            : 'enter'
          : // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy trap passes CSSStyleDeclaration properties through unchanged.
            Reflect.get(target, property)
    })
  })
}

describe('message rail interaction', () => {
  it('opens from the keyboard, reaches prompts, jumps, and restores focus', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    render(
      <NativeChatMessageRail
        rail={{
          items: overflowItems,
          ticks: overflowItems,
          activeId: overflowItems[12].id,
          visible: true
        }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={select}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    await user.tab()
    expect(document.activeElement).toBe(trigger)
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Overflow prompt 12' })
      )
    )
    await user.keyboard('{Enter}')
    expect(select).toHaveBeenCalledWith(overflowItems[12])
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.keyboard('{Enter}')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses the current prompt when a hover preview becomes interactive', async () => {
    render(
      <NativeChatMessageRail
        rail={{
          items: overflowItems,
          ticks: overflowItems,
          activeId: overflowItems[12].id,
          visible: true
        }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    await screen.findByRole('dialog')
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Overflow prompt 12' }))
  })

  it('focuses the first prompt on direct open when no prompt is current', async () => {
    const user = userEvent.setup()
    render(
      <NativeChatMessageRail
        rail={{ items: overflowItems, ticks: overflowItems, activeId: null, visible: true }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Overflow prompt 0' }))
    )
  })

  it('refocuses the current prompt when closed content is reopened before unmount', async () => {
    const styleSpy = retainClosingPopover()
    const user = userEvent.setup()
    try {
      render(
        <NativeChatMessageRail
          rail={{
            items: overflowItems,
            ticks: overflowItems,
            activeId: overflowItems[12].id,
            visible: true
          }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )
      const trigger = screen.getByRole('button', { name: 'Your messages' })
      trigger.focus()
      await user.keyboard('{Enter}')
      await user.keyboard('{Escape}')
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="popover-content"]')?.getAttribute('data-state')
        ).toBe('closed')
      )

      trigger.focus()
      fireEvent.click(trigger)
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Overflow prompt 12' })
        )
      )
    } finally {
      styleSpy.mockRestore()
    }
  })

  it('preserves interactive focus when the current prompt changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <NativeChatMessageRail
        rail={{
          items: overflowItems,
          ticks: overflowItems,
          activeId: overflowItems[12].id,
          visible: true
        }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const focusedPrompt = screen.getByRole('button', { name: 'Overflow prompt 12' })
    expect(document.activeElement).toBe(focusedPrompt)

    rerender(
      <NativeChatMessageRail
        rail={{
          items: overflowItems,
          ticks: overflowItems,
          activeId: overflowItems[13].id,
          visible: true
        }}
        scrollRef={{ current: document.createElement('div') }}
        onSelect={vi.fn()}
      />
    )

    expect(document.activeElement).toBe(focusedPrompt)
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

  // happy-dom has no layout, so these pin which row the panel scrolls to, not
  // the resulting offset. The offset itself only exists in a real browser.
  describe('opening position', () => {
    const scrolled: Element[] = []
    let scrollIntoView: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      scrolled.length = 0
      scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(function mockScrollIntoView(this: Element) {
          scrolled.push(this)
        })
    })
    afterEach(() => scrollIntoView.mockRestore())

    it('scrolls the panel to the message the reader is on', async () => {
      render(
        <NativeChatMessageRail
          rail={{ items, ticks: items, activeId: items[2].id, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Your messages' }), {
        pointerType: 'mouse'
      })
      await screen.findByRole('dialog')
      expect(scrolled).toEqual([screen.getByRole('button', { name: 'Prompt 2' })])
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })

    it('rechecks the current row when messages are inserted before it', async () => {
      const { rerender } = render(
        <NativeChatMessageRail
          rail={{ items, ticks: items, activeId: items[2].id, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Your messages' }), {
        pointerType: 'mouse'
      })
      await screen.findByRole('dialog')
      scrolled.length = 0

      const shiftedItems = [
        { id: 'older-prompt', text: 'Older prompt', slotIndex: 0, hasImages: false },
        ...items.map((item) => ({ ...item, slotIndex: item.slotIndex + 1 }))
      ]
      rerender(
        <NativeChatMessageRail
          rail={{ items: shiftedItems, ticks: shiftedItems, activeId: items[2].id, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )

      expect(scrolled).toEqual([screen.getByRole('button', { name: 'Prompt 2' })])
    })

    it('rechecks the current row when the same number of messages is reordered', async () => {
      const { rerender } = render(
        <NativeChatMessageRail
          rail={{ items, ticks: items, activeId: items[2].id, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Your messages' }), {
        pointerType: 'mouse'
      })
      await screen.findByRole('dialog')
      scrolled.length = 0

      const reorderedItems = [items[2], items[0], items[1]]
      rerender(
        <NativeChatMessageRail
          rail={{
            items: reorderedItems,
            ticks: reorderedItems,
            activeId: items[2].id,
            visible: true
          }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )

      expect(scrolled).toEqual([screen.getByRole('button', { name: 'Prompt 2' })])
    })

    it('leaves the panel alone when no message is lit', async () => {
      render(
        <NativeChatMessageRail
          rail={{ items, ticks: items, activeId: null, visible: true }}
          scrollRef={{ current: document.createElement('div') }}
          onSelect={vi.fn()}
        />
      )
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Your messages' }), {
        pointerType: 'mouse'
      })
      await screen.findByRole('dialog')
      expect(scrolled).toEqual([])
    })
  })
})
