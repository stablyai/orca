// @vitest-environment happy-dom

import { act, startTransition, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const attachmentUrl =
  'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488'

let root: Root | null = null
let container: HTMLDivElement | null = null

function PendingRender({ waitFor }: { waitFor: Promise<void> | null }): null {
  if (waitFor) {
    throw waitFor
  }
  return null
}

function renderCommentMarkdown(
  content: string,
  bodyImageUrls?: Record<string, string>
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <CommentMarkdown variant="document" content={content} bodyImageUrls={bodyImageUrls} />
    )
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

  it('loads signed sources while keeping links and code on canonical URLs', () => {
    const signed =
      'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    const mounted = renderCommentMarkdown(
      [
        `![shot](${attachmentUrl})`,
        `<img src="${attachmentUrl}" alt="raw image">`,
        `[original](${attachmentUrl})`,
        '',
        `\`${attachmentUrl}\``
      ].join('\n'),
      { [attachmentUrl]: signed }
    )
    expect([...mounted.querySelectorAll('img')].map((image) => image.src)).toEqual([signed, signed])
    expect([...mounted.querySelectorAll('a')].map((link) => link.href)).toEqual([
      attachmentUrl,
      attachmentUrl,
      attachmentUrl
    ])
    expect(mounted.querySelector('code')?.textContent).toBe(attachmentUrl)
  })

  it('falls back to the canonical link and retries after an unchanged-body refresh', () => {
    const content = `![shot](${attachmentUrl})`
    const mounted = renderCommentMarkdown(content, {
      [attachmentUrl]: 'https://private-user-images.githubusercontent.com/1/image.png?jwt=EXPIRED'
    })
    act(() => mounted.querySelector('img')?.dispatchEvent(new window.Event('error')))
    expect(mounted.querySelector('img')).toBeNull()
    expect(mounted.querySelector('a')?.href).toBe(attachmentUrl)
    act(() =>
      root?.render(
        <CommentMarkdown
          variant="document"
          content={content}
          bodyImageUrls={{
            [attachmentUrl]:
              'https://private-user-images.githubusercontent.com/1/image.png?jwt=FRESH'
          }}
        />
      )
    )
    expect(mounted.querySelector('img')?.src).toBe(
      'https://private-user-images.githubusercontent.com/1/image.png?jwt=FRESH'
    )
    expect(mounted.querySelector('a')?.href).toBe(attachmentUrl)
  })
  it('retains the committed image when a new candidate render suspends', () => {
    const first = 'https://private-user-images.githubusercontent.com/1/image.png?jwt=FIRST'
    const fresh = 'https://private-user-images.githubusercontent.com/1/image.png?jwt=FRESH'
    const pending = new Promise<void>(() => {})
    const mounted = renderCommentMarkdown('')
    const body = (source: string, waitFor: Promise<void> | null) => (
      <Suspense fallback={null}>
        <CommentMarkdown
          variant="document"
          content={`![shot](${attachmentUrl})`}
          bodyImageUrls={{ [attachmentUrl]: source }}
        />
        <PendingRender waitFor={waitFor} />
      </Suspense>
    )
    act(() => root?.render(body(first, null)))
    const image = mounted.querySelector('img')!
    act(() => startTransition(() => root?.render(body(fresh, pending))))
    expect(mounted.querySelector('img')).toBe(image)
    act(() => image.dispatchEvent(new window.Event('load')))
    act(() => root?.render(body(fresh, null)))
    expect(mounted.querySelector('img')).toBe(image)
    expect(image.src).toBe(first)
  })
})
