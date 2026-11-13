import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown, {
  type CommentMarkdownExtension
} from '@/components/sidebar/CommentMarkdown'
import {
  NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES,
  remarkNativeChatVisuals
} from './native-chat-visual-markdown-syntax'

const boundaryMocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('@/components/sidebar/CommentMermaidBlock', () => ({ default: boundaryMocks.mermaid }))

afterEach(() => {
  try {
    expect(boundaryMocks.mermaid).not.toHaveBeenCalled()
  } finally {
    boundaryMocks.mermaid.mockClear()
  }
})

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
  it('keeps reference links defined after the directive working', () => {
    const markup = render(`See [the docs][d].\n\n${LINE}\n\n[d]: https://example.com/docs`)
    expect(mountedFiles(markup)).toEqual(['usage.html'])
    expect(markup).toContain('href="https://example.com/docs"')
  })
})
