// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const attachmentUrl =
  'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderCommentMarkdown(content: string): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<CommentMarkdown variant="document" content={content} />)
  })
  return container
}

describe('CommentMarkdown GitHub attachment images', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    document.body.replaceChildren()
    root = null
    container = null
  })

  it('renders GitHub user attachment document images as openable links', () => {
    const mounted = renderCommentMarkdown(`![Private issue screenshot](${attachmentUrl})`)

    const link = mounted.querySelector<HTMLAnchorElement>(`a[href="${attachmentUrl}"]`)
    const image = link?.querySelector<HTMLImageElement>('img')

    expect(link).not.toBeNull()
    expect(link?.className).toContain('inline-block')
    expect(image?.src).toBe(attachmentUrl)
    expect(image?.alt).toBe('Private issue screenshot')
  })

  it('falls back to a text link when a GitHub user attachment image cannot load', () => {
    const mounted = renderCommentMarkdown(`![Private issue screenshot](${attachmentUrl})`)
    const image = mounted.querySelector<HTMLImageElement>(`img[src="${attachmentUrl}"]`)

    expect(image).not.toBeNull()
    act(() => {
      image?.dispatchEvent(new window.Event('error'))
    })

    expect(mounted.querySelector(`img[src="${attachmentUrl}"]`)).toBeNull()
    const fallback = mounted.querySelector<HTMLAnchorElement>(`a[href="${attachmentUrl}"]`)
    expect(fallback?.textContent).toBe('Private issue screenshot')
    expect(fallback?.className).toContain('underline')
  })
})
