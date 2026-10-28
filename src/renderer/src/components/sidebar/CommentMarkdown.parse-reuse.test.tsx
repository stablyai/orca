// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { Processor } from 'unified'
import type remarkParsePlugin from 'remark-parse'
import type * as ReactMarkdownModule from 'react-markdown'
import type * as MarkdownBlocksModule from './markdown-top-level-blocks'
import CommentMarkdown from './CommentMarkdown'
import {
  advanceNativeChatText,
  receiveNativeChatText,
  type NativeChatTextReveal
} from '../../../../shared/native-chat/transcript/native-chat-text-reveal'

const meter = vi.hoisted((): { legacy: boolean; sources: string[] } => ({
  legacy: false,
  sources: []
}))
vi.mock('remark-parse', async (original) => {
  const { default: plugin } = await original<{ default: typeof remarkParsePlugin }>()
  return {
    default: function (this: Processor) {
      plugin.call(this)
      const parse = this.parser!
      this.parser = (source, file) => {
        meter.sources.push(source)
        return parse(source, file)
      }
    }
  }
})
vi.mock('react-markdown', async (original) => {
  const real = await original<typeof ReactMarkdownModule>()
  function measureRenderParser(this: Processor): void {
    const parse = this.parser!
    this.parser = (source, file) => {
      meter.sources.push(source)
      return parse(source, file)
    }
  }
  return {
    ...real,
    default: (props: React.ComponentProps<typeof real.default>) =>
      real.default({
        ...props,
        remarkPlugins: [measureRenderParser, ...(props.remarkPlugins ?? [])]
      })
  }
})
vi.mock('./markdown-top-level-blocks', async (original) => {
  const current = await original<typeof MarkdownBlocksModule>()
  const legacy = await import('./markdown-top-level-blocks-legacy.test-fixture')
  return {
    ...current,
    splitMarkdownTopLevelBlocks: (
      ...args: Parameters<typeof current.splitMarkdownTopLevelBlocks>
    ) => {
      const result = meter.legacy
        ? legacy.splitMarkdownTopLevelBlocks(args[0], args[1], args[2])
        : current.splitMarkdownTopLevelBlocks(...args)
      return result
    }
  }
})
vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))

beforeAll(async () => {
  const warm = render(<CommentMarkdown content="$x$" math />)
  await waitFor(() => expect(warm.container.querySelector('.katex')).not.toBeNull())
  warm.unmount()
})
afterEach(() => {
  cleanup()
  meter.legacy = false
  meter.sources = []
})

// The production reveal cadence supplies exactly the same prefixes to both renderers.
function sequence(full: string, start: number): string[] {
  let state: NativeChatTextReveal = { source: full.slice(0, start), shown: start, arrivals: [] }
  let nextArrival = 0
  const result = [state.source]
  for (let frame = 0; frame <= 84; frame++) {
    const now = (frame * 1000) / 60
    while (nextArrival <= Math.min(now, 1008)) {
      const end = Math.min(
        full.length,
        start + Math.ceil(((full.length - start) * (nextArrival + 48)) / 1056)
      )
      state = receiveNativeChatText(state, full.slice(0, end), true, false, nextArrival)
      nextArrival += 48
    }
    state = advanceNativeChatText(state, now)
    const text = state.source.slice(0, state.shown)
    if (text !== result.at(-1)) {
      result.push(text)
    }
  }
  if (result.at(-1) !== full) {
    result.push(full)
  }
  return result
}

const prose =
  'The implementation reads **stable values** and keeps the same behavior for every user. '.repeat(
    650
  )
const fence = `\`\`\`text\n${'const result = readCurrentValue(input);\n'.repeat(1400)}\`\`\``
const list = Array.from(
  { length: 650 },
  (_, i) => `- Item ${i}: preserve **current behavior** and report the measured result.\n`
).join('')
const code = ({ children, sourceLine }: { children?: React.ReactNode; sourceLine?: number }) => (
  <pre data-source-line={sourceLine}>{children}</pre>
)
const exists = () => true

it.each([
  ['short', prose.slice(0, 800), 0],
  ['paragraph', prose.slice(0, 50000), 40000],
  ['fence', fence, 40000],
  ['list', list, 35000],
  ['settled fence and tail', `${fence}\n\n${prose.slice(0, 800)}`, fence.length + 2],
  [
    'backward boundaries',
    'Title\n===\n\n- first\n\n- second\n\n  continued\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    0
  ],
  [
    'global constructs',
    'See [docs][ref].\n\nMore.[^1]\n\n[ref]: https://example.com\n\n[^1]: note\n\n<details>\n\n**hidden**\n\n</details>\n<script>bad()</script>\n<custom>text</custom>',
    0
  ],
  [
    'math and repair',
    'Before **bold** and [link](https://example.com).\n\n$x^2$\n\n$$\nx+y\n$$\n\n\\[z\\]\n\n```math\nx+1\n```\n\n~~~math\ny\n~~~\n\n$unfinished **tail',
    0
  ],
  [
    'positions and links',
    '\n\n  ```ts\nline one\nline two\n  ```\n\n  ~~~text\nother\n  ~~~\n\nEdited src/a.ts and [file](file:///tmp/a.ts).\n\n中文**标点。**后续\n',
    0
  ],
  [
    'indented blocks',
    'Intro\n\n  ```text\n  value\n  ```\n\n  - one\n\n        nested code\n\n  > quote\n  >   ```text\n  >   value\n  >   ```\n\nnext',
    0
  ],
  ['internal BOM', 'one\n\n\uFEFFnext\n\n\uFEFF```text\ncode\n```\n\ntail', 0],
  [
    'line endings',
    'one\r\n\r\n  > quote\r\n\r\n```text\r\ncode\r\n```\r\n\r\nlast\uFEFF word\r\n',
    0
  ]
])(
  'preserves exact DOM and copy text at every reveal update: %s',
  (_name, full, start) => {
    const old = render(<CommentMarkdown content="" growing />)
    const next = render(<CommentMarkdown content="" growing />)
    const props = {
      math: true,
      variant: 'document',
      fadeWords: true,
      unknownHtmlAsText: true,
      allowFileUriLinks: true,
      fileLinkExists: exists,
      renderCodeBlock: code
    } as const
    const prefixes = sequence(full, start)
    for (const [index, content] of [...prefixes, full].entries()) {
      const growing = index < prefixes.length
      meter.legacy = true
      old.rerender(<CommentMarkdown {...props} content={content} growing={growing} />)
      meter.legacy = false
      next.rerender(<CommentMarkdown {...props} content={content} growing={growing} />)
      expect(next.container.innerHTML, `at ${content.length} characters`).toBe(
        old.container.innerHTML
      )
      expect(next.container.textContent).toBe(old.container.textContent)
    }
  },
  55000
)

it('uses one actual parse for discovery and rendering, then skips a completed fence', () => {
  const source = `${fence}\n\nNext`
  meter.sources = []
  const view = render(<CommentMarkdown content={source} math growing renderCodeBlock={code} />)
  expect(meter.sources).toEqual([source])
  meter.sources = []
  view.rerender(<CommentMarkdown content={`${source} words`} math growing renderCodeBlock={code} />)
  expect(meter.sources).toEqual(['Next words'])
  view.unmount()

  const staticView = render(<CommentMarkdown content="unchanged" math />)
  meter.sources = []
  staticView.rerender(<CommentMarkdown content="unchanged" math className="wrapper-change" />)
  expect(meter.sources).toEqual([])
  staticView.unmount()

  meter.legacy = true
  meter.sources = []
  render(<CommentMarkdown content={source} math growing renderCodeBlock={code} />)
  expect(meter.sources.reduce((count, text) => count + text.length, 0)).toBeGreaterThan(
    source.length
  )
})

it('preserves the current cut when the link policy changes', () => {
  const full =
    'Intro\n\n  ```text\n  value\n  ```\n\n  - one\n\n        nested code\n\n  > quote\n '
  const snapshots: string[] = []
  for (const legacy of [true, false]) {
    meter.legacy = legacy
    const view = render(<CommentMarkdown content="" math growing fileLinkExists={exists} />)
    for (const content of sequence(full, 0)) {
      view.rerender(<CommentMarkdown content={content} math growing fileLinkExists={exists} />)
    }
    view.rerender(<CommentMarkdown content={full} math growing fileLinkExists={() => false} />)
    snapshots.push(view.container.innerHTML)
    view.unmount()
  }
  expect(snapshots[1]).toBe(snapshots[0])
})
