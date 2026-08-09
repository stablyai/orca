// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RichMarkdownFollowLinksProvider,
  useCommittedRichMarkdownFollowLinksRef,
  useRichMarkdownFollowLinks
} from './rich-markdown-follow-links-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function FollowLinksRefProbe({
  onCommitted
}: {
  onCommitted: (active: boolean) => void
}): React.JSX.Element {
  const followLinks = useRichMarkdownFollowLinks()
  const activeRef = useCommittedRichMarkdownFollowLinksRef(followLinks?.active ?? false)

  useLayoutEffect(() => {
    onCommitted(activeRef.current)
  }, [activeRef, followLinks?.active, onCommitted])

  return <button onClick={followLinks?.onToggle}>Toggle</button>
}

describe('useCommittedRichMarkdownFollowLinksRef', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('exposes the provider state after each committed toggle', () => {
    const onCommitted = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <RichMarkdownFollowLinksProvider>
          <FollowLinksRefProbe onCommitted={onCommitted} />
        </RichMarkdownFollowLinksProvider>
      )
    })
    expect(onCommitted).toHaveBeenLastCalledWith(false)

    act(() => container.querySelector('button')?.click())
    expect(onCommitted).toHaveBeenLastCalledWith(true)
  })
})
