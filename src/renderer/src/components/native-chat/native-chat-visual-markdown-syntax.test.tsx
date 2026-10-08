import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown, {
  type CommentMarkdownExtension
} from '@/components/sidebar/CommentMarkdown'
import {
  NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES,
  remarkNativeChatVisuals
} from './native-chat-visual-markdown-syntax'

const NONCE = 'nonce-123'

function Probe(props: ComponentProps<'div'> & ExtraProps): React.JSX.Element {
  const nonce = 'data-orca-visual' in props ? props['data-orca-visual'] : undefined
  if (nonce !== NONCE) {
    return <div className={props.className}>{props.children}</div>
  }
  const title = 'data-orca-visual-title' in props ? props['data-orca-visual-title'] : undefined
  const file = 'data-orca-visual-file' in props ? props['data-orca-visual-file'] : undefined
  return (
    <span data-visual={String(file)}>
      {typeof title === 'string' ? `[${title}]` : '[untitled]'}
    </span>
  )
}

const extension: CommentMarkdownExtension = {
  remarkPlugins: [[remarkNativeChatVisuals, NONCE]],
  sanitizeAttributes: { div: [...NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES] },
  components: { div: Probe }
}

function render(content: string): string {
  return renderToStaticMarkup(
    <CommentMarkdown content={content} variant="document" extension={extension} />
  )
}

function mountedFiles(markup: string): string[] {
  return [...markup.matchAll(/data-visual="([^"]+)"/g)].map((match) => match[1])
}

const LINE = '::orca-visual{file="usage.html" title="Usage by day"}'

describe('remarkNativeChatVisuals', () => {
  it('mounts a directive on its own line with its title', () => {
    const markup = render(`Here it is:\n\n${LINE}\n\nThat is the trend.`)
    expect(mountedFiles(markup)).toEqual(['usage.html'])
    expect(markup).toContain('[Usage by day]')
    expect(markup).not.toContain('::orca-visual')
    expect(markup).toContain('That is the trend.')
  })

  it('splits a paragraph that runs straight into and out of the directive', () => {
    const markup = render(`Here it is:\n${LINE}\nThat is the trend.`)
    expect(mountedFiles(markup)).toEqual(['usage.html'])
    expect(markup).toContain('Here it is:')
    expect(markup).toContain('That is the trend.')
  })

  it('mounts at the very end of the reply without a trailing newline', () => {
    expect(mountedFiles(render(`Intro\n\n${LINE}`))).toEqual(['usage.html'])
  })

  it('accepts CRLF line endings and up to three spaces of indent', () => {
    expect(mountedFiles(render(`Intro\r\n\r\n   ${LINE}\r\n\r\nAfter`))).toEqual(['usage.html'])
  })

  it.each([
    ['fenced code', `\`\`\`\n${LINE}\n\`\`\``],
    ['tilde fenced code', `~~~md\n${LINE}\n~~~`],
    ['indented code', `Intro\n\n    ${LINE}`],
    ['inline code', `Use \`${LINE}\` to show a chart.`],
    ['a block quote', `> ${LINE}`],
    ['a list item', `- ${LINE}`],
    ['an ordered list item', `1. ${LINE}`],
    ['mid-sentence', `See ${LINE} here`],
    ['a malformed directive', '::orca-visual{file="../usage.html"}'],
    ['an unclosed directive', '::orca-visual{file="usage.html"'],
    ['trailing prose on the line', `${LINE} done`]
  ])('leaves it as text inside %s', (_name, content) => {
    const markup = render(content)
    expect(mountedFiles(markup)).toEqual([])
    expect(markup).toContain('::orca-visual')
  })

  it('does not mount a raw HTML placeholder forged without the nonce', () => {
    const markup = render(
      '<div data-orca-visual="guess" data-orca-visual-file="usage.html">x</div>\n\nafter'
    )
    expect(mountedFiles(markup)).toEqual([])
  })

  it('mounts a raw HTML placeholder only if it knew the nonce, which the reply cannot', () => {
    // The nonce is per rendered message and never part of the reply, so this cannot be authored.
    const markup = render(
      `<div data-orca-visual="${NONCE}" data-orca-visual-file="usage.html">x</div>`
    )
    expect(mountedFiles(markup)).toEqual(['usage.html'])
  })

  it('caps how many visuals one reply mounts and shows the rest as text', () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `::orca-visual{file="chart-${index}.html"}`
    )
    const markup = render(lines.join('\n\n'))
    expect(mountedFiles(markup)).toEqual(
      Array.from({ length: 8 }, (_, index) => `chart-${index}.html`)
    )
    expect(markup).toContain('chart-8.html')
    expect(markup).toContain('chart-9.html')
  })

  it('keeps reference links defined after the directive working', () => {
    const markup = render(`See [the docs][d].\n\n${LINE}\n\n[d]: https://example.com/docs`)
    expect(mountedFiles(markup)).toEqual(['usage.html'])
    expect(markup).toContain('href="https://example.com/docs"')
  })

  it('renders other markdown unchanged around it', () => {
    const markup = render(`# Title\n\n${LINE}\n\n| a | b |\n| - | - |\n| 1 | 2 |`)
    expect(mountedFiles(markup)).toEqual(['usage.html'])
    expect(markup).toContain('<table')
  })
})

describe('CommentMarkdown without the extension', () => {
  it('shows the directive as text', () => {
    const markup = renderToStaticMarkup(<CommentMarkdown content={LINE} variant="document" />)
    expect(markup).toContain('::orca-visual')
  })
})
