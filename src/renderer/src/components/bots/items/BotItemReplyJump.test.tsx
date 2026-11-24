// @vitest-environment happy-dom

import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import { useBotItemNeedsYouJump } from './BotItemReplyJump'

afterEach(cleanup)

/** An item page whose question sits on an earlier page still being read: Reply waits for it. */
function Page({
  drawn,
  focusComposer
}: {
  drawn: boolean
  focusComposer: () => void
}): React.JSX.Element {
  const pane = useRef<HTMLDivElement | null>(null)
  const scroll = useRef<HTMLDivElement | null>(null)
  const comment = useRef<BotItemCommentBoxHandle | null>({
    focus: focusComposer
  } as unknown as BotItemCommentBoxHandle)
  const jump = useBotItemNeedsYouJump({
    eligible: true,
    activityShown: true,
    loadingTarget: !drawn,
    scrollRef: scroll,
    paneRef: pane,
    revealRow: () => {},
    comment
  })
  return (
    <div ref={pane}>
      <header>{jump.reply}</header>
      <section>
        <button type="button">2 more</button>
      </section>
      <div ref={scroll}>{drawn ? <div ref={jump.mark?.setNode}>Question</div> : null}</div>
    </div>
  )
}

function setup(): { focusComposer: ReturnType<typeof vi.fn>; land: () => void } {
  const focusComposer = vi.fn()
  const view = render(<Page drawn={false} focusComposer={focusComposer} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reply, above' }))
  expect(screen.getByRole('button', { name: 'Reply, above' }).getAttribute('aria-busy')).toBe(
    'true'
  )
  return {
    focusComposer,
    land: () =>
      act(() => {
        view.rerender(<Page drawn focusComposer={focusComposer} />)
      })
  }
}

describe('a Reply waiting on an earlier page', () => {
  it('puts the cursor in the comment box once the page lands', () => {
    const { focusComposer, land } = setup()
    land()
    expect(focusComposer).toHaveBeenCalledTimes(1)
  })

  it('gives way to a pointer press in the details meanwhile', () => {
    const { focusComposer, land } = setup()
    const more = screen.getByRole('button', { name: '2 more' })
    fireEvent.pointerDown(more)
    more.focus()
    fireEvent.pointerUp(more)
    fireEvent.click(more)
    land()
    expect(focusComposer).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(more)
  })

  it('gives way to a key press meanwhile', () => {
    const { focusComposer, land } = setup()
    const more = screen.getByRole('button', { name: '2 more' })
    more.focus()
    fireEvent.keyDown(more, { key: 'Enter' })
    land()
    expect(focusComposer).not.toHaveBeenCalled()
  })
})
