// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'

afterEach(cleanup)

const NO_SLOTS: never[] = []
const NO_ROWS = { messages: [], turnKeys: [] }

/** The rail over the real hook, on a thread known only from the host's outline.
 *  The first two prompts have replies; past 20 the ticks are sampled. */
function Rail({
  count = 3,
  activeIndex,
  scroller,
  ...rest
}: Partial<React.ComponentProps<typeof NativeChatMessageRail>> & {
  count?: number
  activeIndex?: number
  scroller?: HTMLDivElement
}): React.JSX.Element {
  const [scrollRef] = useState(() => ({ current: scroller ?? document.createElement('div') }))
  const [outline] = useState(() =>
    Array.from({ length: count }, (_, index) => ({
      id: `prompt-${index}`,
      text: `Prompt ${index}`,
      hasImages: false,
      reply: index < 2 ? `Reply ${index}` : undefined
    }))
  )
  const rail = useNativeChatMessageRail({
    scrollRef,
    slots: NO_SLOTS,
    turnRows: NO_ROWS,
    virtualItems: NO_SLOTS,
    outline
  })
  const { onActivate } = rail
  useEffect(() => {
    if (activeIndex !== undefined) {
      onActivate(`prompt-${activeIndex}`)
    }
  }, [activeIndex, onActivate])
  return (
    <>
      <input aria-label="Composer" />
      <NativeChatMessageRail rail={rail} scrollRef={scrollRef} onSelect={vi.fn()} {...rest} />
    </>
  )
}

const tick = (name: string): HTMLElement => screen.getByRole('button', { name })
const preview = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-slot="hover-card-content"]')

describe('message rail interaction', () => {
  it('previews only the hovered tick: its message and the reply to it', async () => {
    render(<Rail />)
    fireEvent.pointerEnter(tick('Prompt 1'), { pointerType: 'mouse' })
    await waitFor(() => expect(preview()).not.toBeNull())
    expect(preview()?.textContent).toBe('Prompt 1Reply 1')

    fireEvent.pointerEnter(tick('Prompt 0'), { pointerType: 'mouse' })
    await waitFor(() => expect(preview()?.textContent).toBe('Prompt 0Reply 0'))
  })

  it('previews the message alone while the agent has not replied', async () => {
    render(<Rail />)
    fireEvent.pointerEnter(tick('Prompt 2'), { pointerType: 'mouse' })
    await waitFor(() => expect(preview()).not.toBeNull())
    expect(preview()?.textContent).toBe('Prompt 2')
  })

  it('jumps to the clicked tick', async () => {
    const select = vi.fn()
    render(<Rail onSelect={select} />)
    await userEvent.setup().click(tick('Prompt 1'))
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'prompt-1' }))
  })

  it('keeps focus where it was while a hover preview opens and closes', async () => {
    render(<Rail />)
    const composer = screen.getByRole('textbox')
    composer.focus()
    const rail = screen.getByRole('toolbar', { name: 'Your messages' })
    fireEvent.pointerEnter(rail, { pointerType: 'mouse' })
    fireEvent.pointerEnter(tick('Prompt 0'), { pointerType: 'mouse' })
    await waitFor(() => expect(preview()).not.toBeNull())
    expect(document.activeElement).toBe(composer)
    fireEvent.pointerLeave(rail, { pointerType: 'mouse' })
    await waitFor(() => expect(preview()).toBeNull())
    expect(document.activeElement).toBe(composer)
  })

  it('is one tab stop on the current tick, walked by arrow keys, each previewing itself', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    render(<Rail activeIndex={1} onSelect={select} />)
    screen.getByRole('textbox').focus()
    await user.tab()
    expect(document.activeElement).toBe(tick('Prompt 1'))
    await waitFor(() => expect(preview()).not.toBeNull())
    expect(preview()?.textContent).toBe('Prompt 1Reply 1')

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(tick('Prompt 0'))
    await waitFor(() => expect(preview()?.textContent).toBe('Prompt 0Reply 0'))
    await user.keyboard('{End}{Enter}')
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'prompt-2' }))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(preview()).toBeNull())
    expect(document.activeElement).toBe(tick('Prompt 2'))
    await user.tab()
    expect(screen.getByRole('toolbar').contains(document.activeElement)).toBe(false)
  })

  // A long thread draws only some ticks; the keyboard still reaches every message,
  // and the tick it lands on stays drawn while it holds focus.
  it('walks every message with the arrow keys, sampled onto the rail or not', async () => {
    const user = userEvent.setup()
    render(<Rail count={60} />)
    // Anti-vacuous: the second message has no tick until the keyboard reaches it.
    expect(screen.queryByRole('button', { name: 'Prompt 1' })).toBeNull()
    screen.getByRole('textbox').focus()
    await user.tab()
    expect(document.activeElement).toBe(tick('Prompt 0'))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(tick('Prompt 1'))
    await waitFor(() => expect(preview()?.textContent).toBe('Prompt 1Reply 1'))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(tick('Prompt 2'))
  })

  it('marks a tick whose history is still paging in as busy', () => {
    render(<Rail pendingId="prompt-0" />)
    expect(tick('Prompt 0').getAttribute('aria-busy')).toBe('true')
    expect(tick('Prompt 1').getAttribute('aria-busy')).toBeNull()
  })

  it.each([
    [0, 7],
    [1, 112],
    [2, 2800]
  ])('forwards wheel delta mode %i', (deltaMode, expected) => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { value: 400 })
    render(<Rail scroller={element} />)
    fireEvent.wheel(screen.getByRole('toolbar', { name: 'Your messages' }), {
      deltaY: 7,
      deltaMode
    })
    expect(element.scrollTop).toBe(expected)
  })
})
