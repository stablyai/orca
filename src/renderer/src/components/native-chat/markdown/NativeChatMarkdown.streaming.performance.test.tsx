// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ReactMarkdownModule from 'react-markdown'

const markdownInput = vi.hoisted(() => ({ chars: 0 }))
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>()
  const { createElement } = await import('react')
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      markdownInput.chars += typeof props.children === 'string' ? props.children.length : 0
      return createElement(actual.default, props)
    }
  }
})
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import { TooltipProvider } from '@/components/ui/tooltip'

const BLOCK_CHARS = 200
const TOKEN = ' tick'

function paragraphs(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    `Paragraph ${index} ${'lorem '.repeat(BLOCK_CHARS)}`.slice(0, BLOCK_CHARS)
  ).join('\n\n')
}

function reply(content: string): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatMarkdown content={content} variant="document" streaming />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('streaming native chat markdown parse budget', () => {
  it.each([10, 100])(
    'hands react-markdown only the tail of a %i-block reply per append',
    (blocks) => {
      let content = paragraphs(blocks)
      const { container, rerender } = render(reply(content))
      const firstParagraph = container.querySelector('p')
      expect(firstParagraph).not.toBeNull()
      let widestAppend = 0
      for (let tick = 0; tick < 20; tick += 1) {
        content += TOKEN
        markdownInput.chars = 0
        rerender(reply(content))
        widestAppend = Math.max(widestAppend, markdownInput.chars)
      }
      // The growing block plus the one it may join (2 x 200 + token), with 100 chars of remend slack.
      expect(widestAppend).toBeLessThanOrEqual(505)
      expect(container.querySelector('p')).toBe(firstParagraph)
      expect(container.textContent).toContain(TOKEN.repeat(20).trim())
    }
  )
})
