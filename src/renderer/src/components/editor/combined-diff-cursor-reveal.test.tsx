// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { DiffOnMount } from '@monaco-editor/react'
import { installCombinedDiffCursorReveal } from './combined-diff-cursor-reveal'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  prFilesDiffScrollTopCache,
  prFilesDiffViewStateCache
} from '../pull-request-page/cache/files-diff-view'
import {
  reviewHostFixture,
  reviewHostComponents,
  originalContent,
  modifiedContent
} from './combined-diff-review-host.test-fixture'

// Happy DOM has no canvas adapter; drawing does not participate in cursor geometry.
const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {}
  })
})
afterAll(() => Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContext))
const disposers: (() => void)[] = []
let diff: monaco.editor.IStandaloneDiffEditor
let viewport: HTMLDivElement

function layoutBox(node: HTMLElement, rectangle: () => DOMRect) {
  node.getBoundingClientRect = rectangle
  node.getClientRects = () => Object.assign([rectangle()], { item: () => rectangle() })
}
function configureViewport(node: HTMLDivElement) {
  if (viewport === node) {
    return
  }
  viewport = node
  Object.defineProperties(node, {
    clientHeight: { value: 300, configurable: true },
    offsetHeight: { value: 300, configurable: true },
    offsetWidth: { value: 1000, configurable: true },
    scrollHeight: { value: 2500, configurable: true }
  })
  layoutBox(node, () => new DOMRect(0, 100, 1000, 300))
}
function mountEditor(node: HTMLDivElement, options: monaco.editor.IDiffEditorConstructionOptions) {
  const editor = monaco.editor.createDiffEditor(node, {
    ...options,
    automaticLayout: false,
    dimension: { width: 1000, height: 2200 },
    lineHeight: 20,
    fontSize: 13,
    renderSideBySideInlineBreakpoint: 0,
    hideUnchangedRegions: { enabled: false }
  })
  const original = monaco.editor.createModel(originalContent)
  const modified = monaco.editor.createModel(modifiedContent)
  editor.setModel({ original, modified })
  for (const pane of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
    layoutBox(pane.getContainerDomNode(), () => new DOMRect(0, 130 - viewport.scrollTop, 500, 2200))
  }
  layoutBox(node, () => new DOMRect(0, 130 - viewport.scrollTop, 1000, 2200))
  const header = node
    .closest('[data-combined-diff-section-row]')
    ?.querySelector<HTMLElement>('[data-combined-diff-section-header]')
  if (header) {
    layoutBox(header, () => new DOMRect(0, 100, 1000, 30))
  }
  return {
    editor,
    dispose: () => {
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }
}
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount,
    options
  }: {
    onMount: DiffOnMount
    options: monaco.editor.IDiffEditorConstructionOptions
  }) => {
    const ref = useRef<HTMLDivElement>(null)
    const initial = useRef({ onMount, options })
    useLayoutEffect(() => {
      if (!ref.current) {
        throw new Error('Missing editor host')
      }
      const mounted = mountEditor(ref.current, initial.current.options)
      diff = mounted.editor
      initial.current.onMount(diff, monaco)
      return mounted.dispose
    }, [])
    return <div ref={ref} />
  }
}))
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  prFilesDiffScrollTopCache.clear()
  prFilesDiffViewStateCache.clear()
  document.body.replaceChildren()
  reviewHostFixture.configureViewport = undefined
})

function assertCursorVisible(pane: monaco.editor.IStandaloneCodeEditor) {
  const cursor = pane.getScrolledVisiblePosition(pane.getPosition()!)!
  const top = pane.getContainerDomNode().getBoundingClientRect().top + cursor.top
  expect(top).toBeGreaterThanOrEqual(130)
  expect(top + cursor.height).toBeLessThanOrEqual(400)
}
function navigate(pane: monaco.editor.IStandaloneCodeEditor) {
  pane.focus()
  pane.setPosition({ lineNumber: 1, column: 1 })
  viewport.scrollTop = 0
  for (let index = 0; index < 30; index++) {
    pane.trigger('keyboard', 'cursorDown', null)
  }
  expect(pane.getPosition()?.lineNumber).toBe(31)
  expect(viewport.scrollTop).toBeGreaterThan(0)
  assertCursorVisible(pane)
  pane.trigger('keyboard', 'cursorTop', null)
  assertCursorVisible(pane)
}

it.each([true, false])(
  'reveals keyboard navigation in the outer viewport (split=%s)',
  async (split) => {
    const outer = document.createElement('div')
    outer.setAttribute('data-combined-diff-viewport', '')
    outer.innerHTML =
      '<div data-combined-diff-section-row><div data-combined-diff-section-header></div><div class="editor-host"></div></div>'
    document.body.append(outer)
    configureViewport(outer)
    const mounted = mountEditor(outer.querySelector<HTMLDivElement>('.editor-host')!, {
      renderSideBySide: split
    })
    disposers.push(mounted.dispose)
    disposers.push(installCombinedDiffCursorReveal(mounted.editor))
    await vi.waitFor(() => expect(mounted.editor.getLineChanges()).not.toBeNull())
    for (const pane of [mounted.editor.getOriginalEditor(), mounted.editor.getModifiedEditor()]) {
      navigate(pane)
      const offset = viewport.scrollTop
      pane.setPosition({ lineNumber: 90, column: 1 }, 'mouse')
      expect(viewport.scrollTop).toBe(offset)
      pane.setPosition({ lineNumber: 1, column: 1 }, 'api')
      expect(viewport.scrollTop).toBe(offset)
    }
  }
)

it.each(['page', 'dialog'] as const)(
  'reveals keyboard navigation through the actual PR Files %s host',
  async (host) => {
    reviewHostFixture.configureViewport = configureViewport
    const Viewer = reviewHostComponents[host]
    render(
      <TooltipProvider>
        <Viewer
          files={[
            { path: 'file.ts', status: 'modified', additions: 1, deletions: 1, isBinary: false }
          ]}
          comments={[]}
          repoPath="/repo"
          repoId={`reveal-${host}`}
          prNumber={7}
          prUrl="https://example.test/pr/7"
          headSha="head"
          baseSha="base"
          pendingViewedPaths={new Set<string>()}
          onCommentAdded={() => {}}
          onViewedChange={async () => true}
        />
      </TooltipProvider>
    )
    await vi.waitFor(() => expect(viewport?.querySelector('.monaco-diff-editor')).toBeTruthy())
    await vi.waitFor(() => expect(diff.getLineChanges()).not.toBeNull())
    expect(viewport.hasAttribute('data-combined-diff-viewport')).toBe(true)
    expect(
      viewport.querySelector('[data-combined-diff-section-row] [data-combined-diff-section-header]')
    ).not.toBeNull()
    act(() => navigate(diff.getModifiedEditor()))
  }
)
