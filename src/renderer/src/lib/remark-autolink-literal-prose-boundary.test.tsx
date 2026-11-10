// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MarkdownPreviewBody } from '../components/editor/markdown-preview/render-tree/MarkdownPreviewBody'
import CommentMarkdown from '../components/sidebar/CommentMarkdown'

const boldUrl = '下载：**https://example.com/ujes/**（2026-10-23 已上线）。'
const italicUrl = '_https://example.com/a_。'

function markup(content: string): { chat: HTMLElement; preview: HTMLElement } {
  return {
    chat: render(<CommentMarkdown content={content} />).container,
    preview: render(<MarkdownPreviewBody content={content} components={{}} />).container
  }
}

function expectBoldUrl(container: HTMLElement): void {
  const link = container.querySelector('strong a')
  expect(link?.getAttribute('href')).toBe('https://example.com/ujes/')
  expect(link?.textContent).toBe('https://example.com/ujes/')
  expect(container.textContent).toContain('（2026-10-23 已上线）。')
  expect(container.textContent).not.toContain('**')
}

function expectItalicUrl(container: HTMLElement): void {
  const link = container.querySelector('em a')
  expect(link?.getAttribute('href')).toBe('https://example.com/a')
  expect(link?.textContent).toBe('https://example.com/a')
  expect(container.querySelector('em')?.textContent).toBe('https://example.com/a')
  expect(container.textContent).toContain('。')
  expect(container.textContent).not.toContain('_')
}

it('keeps bold and italic around a bare url that ends at CJK punctuation', () => {
  for (const container of Object.values(markup(`${boldUrl}\n\n${italicUrl}`))) {
    expectBoldUrl(container)
    expectItalicUrl(container)
  }
})

it('keeps bold around a bare url when a space follows the marker', () => {
  for (const container of Object.values(markup('**https://example.com/ujes/** next'))) {
    const link = container.querySelector('strong a')
    expect(link?.getAttribute('href')).toBe('https://example.com/ujes/')
    expect(container.textContent).toContain('next')
    expect(container.textContent).not.toContain('**')
  }
})

it('still ends a bare url at CJK punctuation when it is not emphasised', () => {
  for (const container of Object.values(markup('见 https://example.com/a。'))) {
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/a')
    expect(link?.textContent).toBe('https://example.com/a')
    expect(container.textContent).toContain('。')
  }
})

it('keeps an unpaired marker after a cut url as text', () => {
  for (const container of Object.values(markup('见 https://example.com/a?b=1&c=_*。'))) {
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/a?b=1&c=')
    expect(container.textContent).toContain('_*。')
    expect(container.querySelector('em, strong')).toBeNull()
  }
})
