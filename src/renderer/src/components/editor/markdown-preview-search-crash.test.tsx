// @vitest-environment happy-dom
//
// Regression guards for crash 237acef1: search highlighting must not mutate the
// DOM react-markdown owns. Injecting <mark> by splitting react's text nodes (and
// normalize()-merging them on clear) left react with stale child pointers, so
// the next streamed-content commit threw
//   NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before
//   which the new node is to be inserted is not a child of this node.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'

const SEARCH_HIGHLIGHT_NAME = 'markdown-preview-search-match'
const ACTIVE_SEARCH_HIGHLIGHT_NAME = 'markdown-preview-search-active-match'

function MarkdownBody({ parts }: { parts: readonly string[] }): React.JSX.Element {
  // Mirror react-markdown: a <p> whose children are text nodes react owns.
  return (
    <div className="markdown-body">
      <p>{parts.map((part) => part)}</p>
    </div>
  )
}

describe('markdown preview search highlighting keeps react-owned DOM intact (crash 237acef1)', () => {
  let container: HTMLDivElement
  let root: Root
  const instance = {}

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    clearMarkdownPreviewSearchHighlights(instance)
  })

  function render(parts: readonly string[]): HTMLElement {
    act(() => root.render(<MarkdownBody parts={parts} />))
    const body = container.querySelector<HTMLElement>('.markdown-body')
    if (!body) {
      throw new Error('missing markdown body')
    }
    return body
  }

  it('applies highlights without mutating the react-owned subtree', () => {
    const body = render(['hello world'])
    const matches = applyMarkdownPreviewSearchHighlights(instance, body, 'lo')
    expect(matches.length).toBe(1)
    // No <mark> is injected; the text react owns is byte-for-byte intact.
    expect(body.querySelector('mark')).toBeNull()
    expect(body.textContent).toBe('hello world')
  })

  it('survives a streamed re-render while highlights are active', () => {
    const body = render(['alpha ', 'beta'])
    applyMarkdownPreviewSearchHighlights(instance, body, 'beta')
    // Highlights stay registered while streamed content rewrites the paragraph.
    // When they mutated react's text nodes this commit threw NotFoundError; with
    // no DOM mutation it is clean. (afterEach clears the instance.)
    expect(() => render(['alpha ', 'gamma', ' delta'])).not.toThrow()
  })
})

// The paint path only runs where the CSS Custom Highlight API exists (prod
// Electron), which jsdom/happy-dom lack — so stub a faithful, Electron-shaped
// registry + Highlight to exercise it. The stub Highlight throws if handed any
// constructor argument, catching any accidental `new Highlight(...ranges)`
// spread (which overflows V8's arg stack on large docs).
class StubHighlight {
  readonly ranges = new Set<Range>()
  constructor(...args: Range[]) {
    if (args.length > 0) {
      throw new RangeError('Maximum call stack size exceeded')
    }
  }
  add(range: Range): void {
    this.ranges.add(range)
  }
}

class StubHighlightRegistry {
  readonly entries = new Map<string, StubHighlight>()
  set(name: string, highlight: StubHighlight): void {
    this.entries.set(name, highlight)
  }
  delete(name: string): void {
    this.entries.delete(name)
  }
}

describe('markdown preview search painting with the CSS Custom Highlight API', () => {
  let registry: StubHighlightRegistry

  beforeEach(() => {
    registry = new StubHighlightRegistry()
    vi.stubGlobal('Highlight', StubHighlight)
    vi.stubGlobal('CSS', { highlights: registry })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function bodyWithText(text: string): HTMLElement {
    const div = document.createElement('div')
    div.className = 'markdown-body'
    div.textContent = text
    document.body.append(div)
    return div
  }

  it('paints many matches without a constructor-arg spread', () => {
    const instance = {}
    const body = bodyWithText('a a a a a a a a')
    // A spread paint (new Highlight(...ranges)) would throw via the stub.
    expect(() => applyMarkdownPreviewSearchHighlights(instance, body, 'a')).not.toThrow()
    expect(registry.entries.get(SEARCH_HIGHLIGHT_NAME)?.ranges.size).toBe(8)
    clearMarkdownPreviewSearchHighlights(instance)
    body.remove()
  })

  it('unions highlights across previews so a second Find does not clobber the first', () => {
    const a = {}
    const b = {}
    const bodyA = bodyWithText('alpha alpha')
    const bodyB = bodyWithText('alpha')

    const matchesA = applyMarkdownPreviewSearchHighlights(a, bodyA, 'alpha')
    const matchesB = applyMarkdownPreviewSearchHighlights(b, bodyB, 'alpha')
    expect(matchesA.length).toBe(2)
    expect(matchesB.length).toBe(1)
    // The registry paints the union (A's 2 + B's 1), not just the last writer's.
    expect(registry.entries.get(SEARCH_HIGHLIGHT_NAME)?.ranges.size).toBe(3)

    // Closing B keeps A's highlights.
    clearMarkdownPreviewSearchHighlights(b)
    expect(registry.entries.get(SEARCH_HIGHLIGHT_NAME)?.ranges.size).toBe(2)

    clearMarkdownPreviewSearchHighlights(a)
    expect(registry.entries.has(SEARCH_HIGHLIGHT_NAME)).toBe(false)
    setActiveMarkdownPreviewSearchMatch(a, matchesA, -1)
    bodyA.remove()
    bodyB.remove()
  })

  it('navigation repaints only the active highlight, not the full match set', () => {
    const instance = {}
    const body = bodyWithText('a a a a')
    const matches = applyMarkdownPreviewSearchHighlights(instance, body, 'a')
    const paintedAfterApply = registry.entries.get(SEARCH_HIGHLIGHT_NAME)
    setActiveMarkdownPreviewSearchMatch(instance, matches, 0)
    setActiveMarkdownPreviewSearchMatch(instance, matches, 1)
    // The SEARCH highlight object is untouched by navigation (not rebuilt each Next/Prev)...
    expect(registry.entries.get(SEARCH_HIGHLIGHT_NAME)).toBe(paintedAfterApply)
    // ...while the ACTIVE highlight tracks the current match.
    expect(registry.entries.get(ACTIVE_SEARCH_HIGHLIGHT_NAME)?.ranges.has(matches[1])).toBe(true)
    clearMarkdownPreviewSearchHighlights(instance)
    body.remove()
  })

  it('re-apply drops the active highlight until the caller repaints it (same-count rerender)', () => {
    const instance = {}
    const body = bodyWithText('one two one two')
    const first = applyMarkdownPreviewSearchHighlights(instance, body, 'one')
    expect(first.length).toBe(2)
    setActiveMarkdownPreviewSearchMatch(instance, first, 0)
    expect(registry.entries.has(ACTIVE_SEARCH_HIGHLIGHT_NAME)).toBe(true)

    // A streamed rerender / new query re-applies and clears the active range even
    // when the match count is unchanged (regression for the vanishing active mark).
    const second = applyMarkdownPreviewSearchHighlights(instance, body, 'two')
    expect(second.length).toBe(first.length)
    expect(registry.entries.has(ACTIVE_SEARCH_HIGHLIGHT_NAME)).toBe(false)

    // MarkdownPreview repaints via its searchRevision effect; the module restores it.
    setActiveMarkdownPreviewSearchMatch(instance, second, 0)
    expect(registry.entries.get(ACTIVE_SEARCH_HIGHLIGHT_NAME)?.ranges.has(second[0])).toBe(true)
    clearMarkdownPreviewSearchHighlights(instance)
    body.remove()
  })
})
