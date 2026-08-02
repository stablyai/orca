// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

describe('CommentMarkdown link click handler', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('lets callers intercept rendered document links', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[docs](docs/guide.md)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a[href="docs/guide.md"]')
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'docs/guide.md')
    expect(event.defaultPrevented).toBe(true)
  })

  it('sanitizes file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown variant="document" content="[source](file:///repo/worktree/src/main.ts)" />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('sanitizes raw HTML file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content='<a href="file:///repo/worktree/src/main.ts">source</a>'
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('lets opted-in callers intercept rendered file URI links', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[source](file:///repo/worktree/src/main.ts)"
          onLinkClick={onLinkClick}
          allowFileUriLinks
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>(
      'a[href="file:///repo/worktree/src/main.ts"]'
    )
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(
      expect.any(Object),
      'file:///repo/worktree/src/main.ts'
    )
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets callers intercept rendered document images', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="![diagram](assets/diagram.png)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const image = container.querySelector<HTMLImageElement>('img[alt="diagram"]')
    expect(image?.getAttribute('src')).toBe('assets/diagram.png')
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      image?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'assets/diagram.png')
    expect(event.defaultPrevented).toBe(true)
  })
})
