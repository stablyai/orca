// @vitest-environment happy-dom

import { act, startTransition, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it.each([10, 100])(
    'retains %s successfully loaded sources across signature-only refreshes',
    (n) => {
      const urls = Array.from(
        { length: n },
        (_, i) =>
          `https://github.enterprise/team/repo/assets/42/ce11040a-fb66-4289-927f-${String(i).padStart(12, '0')}`
      )
      const content = urls.map((url) => `![shot](${url})`).join('\n')
      const first = Object.fromEntries(urls.map((url) => [url, `${url}?jwt=FIRST`]))
      const fresh = Object.fromEntries(urls.map((url) => [url, `${url}?jwt=FRESH`]))
      const mounted = renderCommentMarkdown(content, first)
      const images = [...mounted.querySelectorAll('img')]
      expect(images).toHaveLength(n)
      act(() => images.forEach((img) => img.dispatchEvent(new window.Event('load'))))
      act(() =>
        root?.render(<CommentMarkdown variant="document" content={content} bodyImageUrls={fresh} />)
      )
      expect([...mounted.querySelectorAll('img')]).toEqual(images)
      expect(images.map((img) => img.src)).toEqual(Object.values(first))
      act(() => root?.render(<CommentMarkdown variant="document" content={content} />))
      expect([...mounted.querySelectorAll('img')]).toEqual(images)
      expect(images[0].src).toBe(first[urls[0]])
      act(() =>
        root?.render(<CommentMarkdown variant="document" content={content} bodyImageUrls={fresh} />)
      )
      act(() => images[0].dispatchEvent(new window.Event('error')))
      expect(mounted.querySelector('img')?.src).toBe(fresh[urls[0]])
      act(() =>
        root?.render(
          <CommentMarkdown
            variant="document"
            content={`![new](${attachmentUrl})`}
            bodyImageUrls={{
              [attachmentUrl]: 'https://private-user-images.githubusercontent.com/1/new.png?jwt=NEW'
            }}
          />
        )
      )
      expect(mounted.querySelector('img')?.src).toBe(
        'https://private-user-images.githubusercontent.com/1/new.png?jwt=NEW'
      )
      act(() => images[0].dispatchEvent(new window.Event('load')))
      expect(mounted.querySelector('img')?.src).toBe(
        'https://private-user-images.githubusercontent.com/1/new.png?jwt=NEW'
      )
    }
  )
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

  it('preserves in-app image clicks for unrelated asset URLs', () => {
    const mounted = renderCommentMarkdown('')
    const onLinkClick = vi.fn()
    act(() =>
      root?.render(
        <CommentMarkdown
          variant="document"
          content="![diagram](https://cdn.example.com/assets/ce11040a-fb66-4289-927f-547b16dfc488)"
          onLinkClick={onLinkClick}
        />
      )
    )
    act(() => mounted.querySelector('img')?.click())
    expect(onLinkClick).toHaveBeenCalledWith(
      expect.anything(),
      'https://cdn.example.com/assets/ce11040a-fb66-4289-927f-547b16dfc488'
    )
  })
})
