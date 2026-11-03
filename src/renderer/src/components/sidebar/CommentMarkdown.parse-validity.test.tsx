// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Processor } from 'unified'
import type remarkParsePlugin from 'remark-parse'
import type * as ReactMarkdownModule from 'react-markdown'
import type * as BlocksModule from './markdown-top-level-blocks'
import type { Root } from 'mdast'
import CommentMarkdown, { type CommentMarkdownExtension } from './CommentMarkdown'
import { createParseWork, meterPositions, nodeCount } from './markdown-parse-meter.test-fixture'
import { NativeChatMarkdown } from '../native-chat/NativeChatMarkdown'
import { NativeChatVisualOwnerContext } from '../native-chat/native-chat-visual-owner'
import { NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER } from '../../../../shared/native-chat/native-chat-visual-directive'
import { remarkNativeChatVisuals } from '../native-chat/native-chat-visual-markdown-syntax'

const meter = vi.hoisted(
  (): { legacy: boolean; work: ReturnType<typeof createParseWork> | null } => ({
    legacy: false,
    work: null
  })
)
vi.mock('remark-parse', async (original) => {
  const { default: plugin } = await original<{ default: typeof remarkParsePlugin }>()
  return {
    default: function (this: Processor) {
      plugin.call(this)
      const parse = this.parser!
      this.parser = (source, file) => {
        meter.work?.discovery.push(source)
        const tree = parse(source, file)
        if (isRoot(tree)) {
          meterPositions(tree, () => {
            if (meter.work) {
              meter.work.shifts++
            }
          })
        }
        return tree
      }
    }
  }
})
vi.mock('react-markdown', async (original) => {
  const real = await original<typeof ReactMarkdownModule>()
  function measureOriginal(this: Processor): void {
    const parse = this.parser!
    this.parser = (source, file) => {
      meter.work?.render.push(source)
      return parse(source, file)
    }
  }
  return {
    ...real,
    default: (props: React.ComponentProps<typeof real.default>) =>
      real.default({
        ...props,
        remarkPlugins: [measureOriginal, ...(props.remarkPlugins ?? [])]
      })
  }
})
vi.mock('./markdown-top-level-blocks', async (original) => {
  const current = await original<typeof BlocksModule>()
  const legacy = await import('./markdown-top-level-blocks-legacy.test-fixture')
  return {
    ...current,
    splitMarkdownTopLevelBlocks: (
      ...args: Parameters<typeof current.splitMarkdownTopLevelBlocks>
    ) => {
      const result = meter.legacy
        ? legacy.splitMarkdownTopLevelBlocks(args[0], args[1], args[2])
        : current.splitMarkdownTopLevelBlocks(...args)
      if (meter.work) {
        meter.work.blocks = Math.max(meter.work.blocks, result.blocks.length)
      }
      return result
    }
  }
})
vi.mock('../native-chat/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: ({ file }: { file: string }) => <div data-visual-file={file} />
}))
vi.mock('../native-chat/use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))

afterEach(() => {
  cleanup()
  meter.legacy = false
  meter.work = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function isRoot(value: unknown): value is Root {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'root' &&
    'children' in value &&
    Array.isArray(value.children)
  )
}
const owner = { target: { kind: 'local' }, sessionId: 's', worktreeId: 'w' } as const
const code = ({ children, sourceLine }: { children?: React.ReactNode; sourceLine?: number }) => (
  <pre data-source-line={sourceLine}>{children}</pre>
)
function native(
  content: string,
  growing = true,
  enabled = true,
  variant: 'document' | undefined = undefined
) {
  return (
    <NativeChatVisualOwnerContext.Provider value={enabled ? owner : null}>
      <NativeChatMarkdown
        content={content}
        visualMessageId="m"
        growing={growing}
        streaming={growing}
        variant={variant}
        renderCodeBlock={code}
      />
    </NativeChatVisualOwnerContext.Provider>
  )
}
const directive = (i = 0) => `::orca-visual{file="v${i}.html"}`
const prefix = '```text\nsettled\n```\n\nNext'

it.each([
  [
    'adjacent',
    `${prefix}\n\n${Array.from({ length: 10 }, (_, i) => directive(i)).join('\n')}\n\nend`,
    8
  ],
  ['separated', `${Array.from({ length: 10 }, (_, i) => directive(i)).join('\n\n')}\n\nend`, 10],
  ['lazy list', `- a\n  ${directive()}\nfoo\n\nbar`, 0],
  ['lazy quote', `> a\n${directive()}\nfoo\n\nbar`, 1],
  ['nested', `- item\n\n  ${directive()}\n\n> ${directive(1)}\n\nend`, 0],
  ['fenced marker', `~~~text\n${directive()}\n~~~\n\nend`, 0],
  ['title CRLF', '::orca-visual{file="v0.html" title="Title"}\r\n\r\nend', 1],
  [
    'invalid escaped overlength',
    `\\${directive()}\n\n::orca-visual{file="../bad.html"}\n\n::orca-visual{file="v.html" title="${'x'.repeat(520)}"}\n\nend`,
    0
  ],
  [
    'chart prose math CJK',
    `${directive()}\n\n中文**标点。** $x+1$ and **tail\n\n[ref]: https://example.com`,
    1
  ],
  [
    'BOM and sliced context',
    `one\n\n\uFEFFnext\n\n  ~~~text\n  value\n  ~~~\n\n${directive()}\n\nend`,
    1
  ]
])(
  'retains exact native DOM/text at every filtered prefix and completion: %s',
  (_name, full, mounts) => {
    const old = render(native(''))
    const next = render(native(''))
    for (let end = 0; end <= full.length + 1; end++) {
      const content = full.slice(0, end)
      meter.legacy = true
      old.rerender(native(content, end <= full.length))
      meter.legacy = false
      next.rerender(native(content, end <= full.length))
      expect(next.container.innerHTML, `prefix ${end}`).toBe(old.container.innerHTML)
      expect(next.container.textContent).toBe(old.container.textContent)
    }
    expect(next.container.querySelectorAll('[data-visual-file]')).toHaveLength(mounts)
    if (_name === 'adjacent') {
      expect(next.container.textContent).toContain(directive(9))
    }
  },
  55000
)

it('preserves historical cuts across config, replacement, completion, re-entry and remount', () => {
  const snapshots: string[][] = []
  for (const legacy of [true, false]) {
    meter.legacy = legacy
    let view = render(native(prefix, true, false))
    const results: string[] = []
    const steps: [string, boolean, boolean, 'document' | undefined][] = [
      [prefix, true, true, undefined],
      [prefix, true, false, undefined],
      [prefix, true, true, 'document'],
      [`${prefix}\n\n${directive()}\n\nMore`, true, true, 'document'],
      [`${prefix}\n\n${directive()}\n\nMore`, false, true, 'document'],
      [`${prefix}\n\n${directive()}\n\nMore words`, true, true, 'document'],
      ['replacement', true, true, undefined],
      [directive(), true, true, undefined],
      [directive(), false, true, undefined],
      [`${prefix}\n\n::orca-visual{file="v`, true, true, undefined],
      [`${prefix}\n\n::orca-visual{file="v`, false, true, undefined],
      ['', true, true, undefined],
      ['one\n\n\uFEFFtail', true, true, undefined],
      [prefix, true, true, undefined]
    ]
    for (const step of steps) {
      view.rerender(native(...step))
      results.push(view.container.innerHTML)
    }
    view.unmount()
    view = render(native(`${directive()}\n\nend`))
    results.push(view.container.innerHTML)
    view.unmount()
    view = render(native(`${directive()}\n\nend`, false))
    results.push(view.container.innerHTML)
    view.unmount()
    snapshots.push(results)
  }
  expect(snapshots[1]).toEqual(snapshots[0])
})

it('defaults unknown ordinary-node syntax to legacy cuts, but permits image-only plugins', () => {
  function extraSyntax(this: Processor): void {
    const parse = this.parser!
    this.parser = (source, file) => parse(source.replaceAll(' / ', '\n\n\n'), file)
  }
  const unknown: CommentMarkdownExtension = {
    remarkPlugins: [extraSyntax],
    sanitizeAttributes: {},
    components: {}
  }
  const outputs: string[] = []
  for (const legacy of [true, false]) {
    meter.legacy = legacy
    const view = render(<CommentMarkdown content="one / two" growing extension={unknown} />)
    outputs.push(view.container.innerHTML)
    view.unmount()
  }
  expect(outputs[1]).toBe(outputs[0])
  meter.legacy = false
  meter.work = createParseWork()
  render(
    <CommentMarkdown
      content={prefix}
      growing
      extension={{ remarkPlugins: [], sanitizeAttributes: {}, components: {} }}
      renderCodeBlock={code}
    />
  )
  expect(meter.work.discovery).toEqual([prefix])
  expect(meter.work.render).toEqual([])
})

it('keeps selected fade nodes and their clocks through a declined tail and completion', () => {
  vi.useFakeTimers()
  const extension: CommentMarkdownExtension = {
    remarkPlugins: [[remarkNativeChatVisuals, 'n']],
    extraFlowSyntaxMarkers: [NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER],
    sanitizeAttributes: {},
    components: {}
  }
  const view = render(
    <CommentMarkdown
      content={`${prefix}\n\nselected words`}
      growing
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  const fence = view.container.querySelector('pre')
  const word = [...view.container.querySelectorAll('[data-word]')].find(
    (node) => node.textContent === 'selected'
  )!
  const range = document.createRange()
  range.selectNodeContents(word)
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(150))
  const content = `${prefix}\n\nselected words\n\n${directive()}\n\nnew words`
  view.rerender(
    <CommentMarkdown
      content={content}
      growing
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  expect(view.container.querySelector('pre')).toBe(fence)
  expect(word.isConnected).toBe(true)
  act(() => vi.advanceTimersByTime(150))
  expect(word.isConnected).toBe(true)
  expect(
    [...view.container.querySelectorAll('[data-word]')].some((node) => node.textContent === 'new')
  ).toBe(true)
  view.rerender(
    <CommentMarkdown
      content={content}
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  expect(document.getSelection()?.toString()).toBe('selected')
  document.getSelection()?.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(1))
  expect(word.isConnected).toBe(false)
})

function installWorkMeters(): void {
  const clone = globalThis.structuredClone
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(<T,>(value: T): T => {
    if (meter.work && isRoot(value)) {
      meter.work.cloneNodes += nodeCount(value)
      meter.work.cloneBytes += JSON.stringify(value).length
    }
    return clone(value)
  })
  const includes = String.prototype.includes
  vi.spyOn(String.prototype, 'includes').mockImplementation(function (
    this: string,
    marker,
    position
  ) {
    if (meter.work && (marker === '\uFEFF' || marker === NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)) {
      meter.work.scans.push({ source: String(this), marker })
    }
    return includes.call(this, marker, position)
  })
}

it.each([20, 200])(
  'bounds actual parsing, clone, position and scan work at production updates N=%i',
  (n) => {
    installWorkMeters()
    const fence = `\`\`\`text\n${'value\n'.repeat(n)}\`\`\`\n\n`
    const tails = [
      'Next',
      ...Array.from({ length: n }, (_, i) => `Next${'x'.repeat(i + 1)}`),
      `Next${'x'.repeat(n)}\n\n${directive()}\n\nend`
    ]
    const runs: ReturnType<typeof createParseWork>[][] = []
    for (const legacy of [true, false]) {
      meter.legacy = legacy
      meter.work = null
      const view = render(native('', true, true, 'document'))
      const updates: ReturnType<typeof createParseWork>[] = []
      for (const tail of tails) {
        meter.work = createParseWork()
        view.rerender(native(fence + tail, true, true, 'document'))
        updates.push(meter.work)
      }
      view.unmount()
      runs.push(updates)
    }
    const optimized = runs[1]
    expect(optimized[0].discovery).toEqual([fence + tails[0]])
    for (let i = 1; i <= n; i++) {
      const work = optimized[i]
      expect(work.discovery).toEqual([tails[i]])
      expect(work.render).toEqual([])
      expect(work.shifts).toBe(4)
      expect(work.cloneNodes).toBe(3)
      expect(work.cloneBytes).toBeLessThan(tails[i].length + 400)
      expect(work.blocks).toBe(2)
      expect(work.scans).toEqual([
        { source: fence + tails[i], marker: '\uFEFF' },
        { source: tails[i], marker: NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER }
      ])
    }
    const rejected = optimized.at(-1)!
    expect(rejected.discovery).toEqual([fence + tails.at(-1)])
    expect(rejected.render.some((source) => source.includes('value\n'))).toBe(false)
    expect(rejected.render.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(
      runs[0].at(-1)!.render.reduce((n, s) => n + s.length, 0)
    )
    expect(rejected.shifts).toBe(0)
    expect(rejected.cloneNodes).toBe(0)
    expect(rejected.blocks).toBe(4)
  }
)

it.each([20, 200])('keeps visual-adjacent fallback parse work within main at N=%i', (n) => {
  const runs: ReturnType<typeof createParseWork>[][] = []
  const outputs: string[][] = []
  for (const legacy of [true, false]) {
    meter.legacy = legacy
    meter.work = null
    const view = render(native(''))
    const updates: ReturnType<typeof createParseWork>[] = []
    const html: string[] = []
    for (let i = 0; i <= n; i++) {
      meter.work = createParseWork()
      view.rerender(native(`${directive()}\n\n${'word '.repeat(i)}end`))
      updates.push(meter.work)
      html.push(view.container.innerHTML)
    }
    view.unmount()
    runs.push(updates)
    outputs.push(html)
  }
  expect(outputs[1]).toEqual(outputs[0])
  for (let i = 0; i <= n; i++) {
    expect(runs[1][i].discovery).toEqual(runs[0][i].discovery)
    expect(runs[1][i].render).toEqual(runs[0][i].render)
    expect(runs[1][i].shifts).toBe(0)
  }
})

it('leaves old visual/fence elements mounted when reuse resumes beyond an earlier marker', () => {
  const full = `${directive()}\n\n${prefix}`
  const view = render(native(full))
  const visual = view.container.querySelector('[data-visual-file]')
  const fence = view.container.querySelector('pre')
  view.rerender(native(`${full} words`))
  meter.work = createParseWork()
  view.rerender(native(`${full} words again`))
  expect(meter.work.discovery).toEqual(['Next words again'])
  view.rerender(native(`${full} words again\n\n${directive(1)}\n\nend`))
  expect(view.container.querySelector('[data-visual-file]')).toBe(visual)
  expect(view.container.querySelector('pre')).toBe(fence)
})

it('invalidates raw grammar metadata when an extension nonce changes on the same source', () => {
  const makeExtension = (nonce: string): CommentMarkdownExtension => ({
    remarkPlugins: [[remarkNativeChatVisuals, nonce]],
    extraFlowSyntaxMarkers: [NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER],
    sanitizeAttributes: {},
    components: {}
  })
  const snapshots: string[][] = []
  for (const legacy of [true, false]) {
    meter.legacy = legacy
    const first = makeExtension('first'),
      second = makeExtension('second')
    const view = render(
      <CommentMarkdown content={prefix} growing extension={first} renderCodeBlock={code} />
    )
    view.rerender(
      <CommentMarkdown content={prefix} growing extension={second} renderCodeBlock={code} />
    )
    const html = [view.container.innerHTML]
    view.rerender(
      <CommentMarkdown
        content={`${prefix}\n\n${directive()}\n\nend`}
        growing
        extension={second}
        renderCodeBlock={code}
      />
    )
    html.push(view.container.innerHTML)
    snapshots.push(html)
    view.unmount()
  }
  expect(snapshots[1]).toEqual(snapshots[0])
})

it.each([20, 200])(
  'excludes the settled prefix from syntax/clone work with a bounded live tail N=%i',
  (n) => {
    installWorkMeters()
    const fence = `\`\`\`text\n${'value\n'.repeat(n)}\`\`\`\n\n`
    let source = `${fence}word`
    const view = render(native(source, true, true, 'document'))
    for (let i = 1; i <= n; i++) {
      source += '\n\nword'
      meter.work = createParseWork()
      view.rerender(native(source, true, true, 'document'))
      expect(meter.work.discovery).toHaveLength(1)
      expect(meter.work.discovery[0].length).toBeLessThanOrEqual(16)
      expect(meter.work.render).toEqual([])
      expect(meter.work.shifts).toBeLessThanOrEqual(8)
      expect(meter.work.cloneNodes).toBeLessThanOrEqual(6)
      expect(meter.work.cloneBytes).toBeLessThanOrEqual(800)
      expect(meter.work.scans).toEqual([
        { source, marker: '\uFEFF' },
        { source: meter.work.discovery[0], marker: NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER }
      ])
      expect(meter.work.blocks).toBe(i + 2)
    }
  }
)
