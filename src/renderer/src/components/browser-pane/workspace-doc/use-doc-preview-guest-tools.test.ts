// @vitest-environment happy-dom
//
// One id runs through this hook, and it is the browser page. A re-mint replaces the guest under
// that page rather than renaming the surface, so annotations stay addressable and the tool target
// keeps naming something main can resolve — the two used to be separate ids, and swapping them was
// invisible until a preview re-minted.
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  annotationSend: [] as { browserTabId: string }[],
  grabAnnotations: [] as { browserTabId: string; toolTargetId: string }[],
  grabMode: [] as string[],
  viewportBridge: [] as { toolTargetId: string }[]
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-annotation-send', () => ({
  useBrowserPageAnnotationSend: (args: { browserTabId: string }) => {
    calls.annotationSend.push({ browserTabId: args.browserTabId })
    return { browserAnnotations: [], setBrowserAnnotationTrayOpen: () => undefined }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-grab-annotations', () => ({
  useBrowserPageGrabAnnotations: (args: { browserTabId: string; toolTargetId: string }) => {
    calls.grabAnnotations.push({
      browserTabId: args.browserTabId,
      toolTargetId: args.toolTargetId
    })
    return { pendingAnnotationPayload: null, grabIntent: null, startGrabIntent: () => undefined }
  }
}))

vi.mock('@/components/browser-pane/annotate/use-browser-page-markup-capture', () => ({
  useBrowserPageMarkupCapture: () => ({ isActive: false })
}))

vi.mock('@/components/browser-pane/annotate/useGrabMode', () => ({
  useGrabMode: (toolTargetId: string) => {
    calls.grabMode.push(toolTargetId)
    return { state: 'idle' }
  }
}))

vi.mock('@/components/browser-pane/annotate/guest-annotation-viewport-bridge', () => ({
  syncGuestAnnotationViewportBridge: (args: { toolTargetId: string }) => {
    calls.viewportBridge.push({ toolTargetId: args.toolTargetId })
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'G' }))

import { useDocPreviewGuestTools } from './use-doc-preview-guest-tools'

const PREVIEW_ID = 'browser-page-9f2c'
const FIRST_GRANT = 'a'.repeat(32)
const SECOND_GRANT = 'b'.repeat(32)

function Harness({ grantId }: { grantId: string | null }): null {
  const webviewRef = useRef(null)
  const containerRef = useRef(null)
  useDocPreviewGuestTools({
    previewId: PREVIEW_ID,
    worktreeId: 'wt-1',
    grantId,
    webviewRef: webviewRef as never,
    containerRef: containerRef as never,
    toolsReady: true
  })
  return null
}

let container: HTMLDivElement
let root: Root

function render(grantId: string | null): void {
  act(() => {
    root.render(createElement(Harness, { grantId }))
  })
}

beforeEach(() => {
  calls.annotationSend.length = 0
  calls.grabAnnotations.length = 0
  calls.grabMode.length = 0
  calls.viewportBridge.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useDocPreviewGuestTools ids', () => {
  it('scopes annotations and tools to the browser page the document is open in', () => {
    render(FIRST_GRANT)

    expect(calls.annotationSend.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.browserTabId).toBe(PREVIEW_ID)
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe(PREVIEW_ID)
    expect(calls.grabMode.at(-1)).toBe(PREVIEW_ID)
  })

  // Why a re-mint is still worth a test with one id: main re-points the page at the replacement
  // guest, so the surface the reader is looking at must keep the same name through it. A hook that
  // rebuilt its target from the grant would orphan annotations under an id nothing reads again.
  it('keeps naming the same surface across a re-mint', () => {
    render(FIRST_GRANT)
    render(SECOND_GRANT)

    expect(new Set(calls.annotationSend.map((call) => call.browserTabId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(new Set(calls.grabAnnotations.map((call) => call.toolTargetId))).toEqual(
      new Set([PREVIEW_ID])
    )
    expect(calls.viewportBridge.at(-1)?.toolTargetId).toBe(PREVIEW_ID)
  })

  // Why an empty target and not the page id: before a grant exists no guest has committed to this
  // page, so naming it would park every tool request in the registration wait for a document the
  // reader may never get.
  it('names no tool target before a grant exists', () => {
    render(null)

    expect(calls.grabMode.at(-1)).toBe('')
    expect(calls.grabAnnotations.at(-1)?.toolTargetId).toBe('')
    expect(calls.viewportBridge).toHaveLength(0)
  })
})
