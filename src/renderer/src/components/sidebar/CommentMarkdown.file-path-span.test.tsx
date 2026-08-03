// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown, { type CommentMarkdownFilePathSpans } from './CommentMarkdown'
import { isFilePathCodeSpan } from '@/lib/file-path-code-span'

describe('CommentMarkdown inline-code file paths', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  const render = (content: string, spans?: CommentMarkdownFilePathSpans): void => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<CommentMarkdown variant="document" content={content} filePathSpans={spans} />)
    })
  }

  const spansWith = (onOpen: CommentMarkdownFilePathSpans['onOpen']) => ({
    isFilePath: isFilePathCodeSpan,
    onOpen
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('renders an inline-code path as an activatable button', () => {
    const onOpen = vi.fn()
    render('see `docs/guide.md` for details', spansWith(onOpen))

    const button = container?.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('docs/guide.md')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0]?.[1]).toBe('docs/guide.md')
  })

  it('keeps code-formatted authored links owned by their anchor', () => {
    const onOpen = vi.fn()
    render('[`docs/a.ts`](https://example.com)', spansWith(onOpen))

    expect(container?.querySelector('button')).toBeNull()
    const anchor = container?.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    expect(anchor?.querySelector('code')?.textContent).toBe('docs/a.ts')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves a fenced code block inert', () => {
    // react-markdown routes fenced and inline code through the same slot, so a
    // bare fence whose only line is a path must not become a button.
    const onOpen = vi.fn()
    render('```\ndocs/guide.md\n```', spansWith(onOpen))

    expect(container?.querySelector('pre')).not.toBeNull()
    expect(container?.querySelector('button')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves a language-tagged fenced block inert', () => {
    const onOpen = vi.fn()
    render('```sh\ndocs/guide.md\n```', spansWith(onOpen))

    expect(container?.querySelector('button')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves a non-path code span as plain code', () => {
    const onOpen = vi.fn()
    render('run `npm run build` first', spansWith(onOpen))

    expect(container?.querySelector('button')).toBeNull()
    expect(container?.querySelector('code')?.textContent).toBe('npm run build')
  })

  it('renders plain code when no caller opts in', () => {
    render('see `docs/guide.md` for details')

    expect(container?.querySelector('button')).toBeNull()
    expect(container?.querySelector('code')?.textContent).toBe('docs/guide.md')
  })

  describe('bare prose paths', () => {
    it('linkifies an unbackticked path and claims the click', () => {
      const onOpen = vi.fn()
      render('Design doc written: docs/mobile-chat-file-path-links.md .', spansWith(onOpen))

      const anchor = container?.querySelector('a')
      expect(anchor?.textContent).toBe('docs/mobile-chat-file-path-links.md')

      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      act(() => {
        anchor?.dispatchEvent(event)
      })
      expect(onOpen).toHaveBeenCalledTimes(1)
      expect(onOpen.mock.calls[0]?.[1]).toBe('docs/mobile-chat-file-path-links.md')
      // A file path is not a URL; letting the anchor navigate would be a bug.
      expect(event.defaultPrevented).toBe(true)
    })

    it('does not linkify prose when no caller opts in', () => {
      render('Design doc written: docs/guide.md .')

      expect(container?.querySelector('a')).toBeNull()
    })

    it('leaves a real web link alone', () => {
      const onOpen = vi.fn()
      render('see https://example.com/docs/guide.md now', spansWith(onOpen))

      const anchor = container?.querySelector('a')
      expect(anchor?.getAttribute('href')).toBe('https://example.com/docs/guide.md')
      expect(anchor?.getAttribute('target')).toBe('_blank')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('does not linkify a version number', () => {
      const onOpen = vi.fn()
      render('upgraded to 1.2.3 and requires Node.js 20', spansWith(onOpen))

      expect(container?.querySelector('a')).toBeNull()
    })

    it('leaves prose inside a fenced block alone', () => {
      const onOpen = vi.fn()
      render('```\nsee docs/guide.md here\n```', spansWith(onOpen))

      expect(container?.querySelector('a')).toBeNull()
      expect(container?.querySelector('pre')).not.toBeNull()
    })

    it('leaves reference-link labels untouched', () => {
      const onOpen = vi.fn()
      render('[docs/a.ts][guide]\n\n[guide]: https://example.com', spansWith(onOpen))

      const anchors = container?.querySelectorAll('a')
      expect(anchors).toHaveLength(1)
      expect(anchors?.[0]?.getAttribute('href')).toBe('https://example.com')
      expect(anchors?.[0]?.textContent).toBe('docs/a.ts')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('keeps Windows drive paths alive through markdown sanitization', () => {
      const onOpen = vi.fn()
      render(String.raw`Open C:\repo\src\app.ts`, spansWith(onOpen))

      const anchor = container?.querySelector('a')
      expect(anchor?.textContent).toBe(String.raw`C:\repo\src\app.ts`)
      expect(anchor?.getAttribute('href')).toContain('C%3A')
      act(() => {
        anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(onOpen).toHaveBeenCalledOnce()
      expect(onOpen.mock.calls[0]?.[1]).toContain('C%3A')
    })
  })
})
