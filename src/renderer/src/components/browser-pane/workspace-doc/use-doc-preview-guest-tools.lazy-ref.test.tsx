// @vitest-environment happy-dom

/**
 * The annotation viewport bridge token used to sit in a `useRef(...)` argument, so every render of
 * a doc preview minted a fresh `crypto.randomUUID()` and threw it away — only the mount-time token
 * was ever read. Pin the mint count to the mount count.
 */
import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const browserUuidCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => {
    browserUuidCalls.count += 1
    return `00000000-0000-4000-8000-${String(browserUuidCalls.count).padStart(12, '0')}`
  }
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Cmd+G' }))
vi.mock('@/components/browser-pane/annotate/guest-annotation-viewport-bridge', () => ({
  syncGuestAnnotationViewportBridge: vi.fn()
}))
vi.mock('@/components/browser-pane/annotate/use-browser-page-annotation-send', () => ({
  useBrowserPageAnnotationSend: () => ({
    browserAnnotations: [],
    setBrowserAnnotationTrayOpen: vi.fn()
  })
}))
vi.mock('@/components/browser-pane/annotate/use-browser-page-grab-annotations', () => ({
  useBrowserPageGrabAnnotations: () => ({})
}))
vi.mock('@/components/browser-pane/annotate/use-browser-page-markup-capture', () => ({
  useBrowserPageMarkupCapture: () => ({})
}))
vi.mock('@/components/browser-pane/annotate/useGrabMode', () => ({
  useGrabMode: () => ({ active: false })
}))

const { useDocPreviewGuestTools } = await import('./use-doc-preview-guest-tools')

let bumpRender: (() => void) | null = null

function Host(): null {
  const [, setTick] = useState(0)
  bumpRender = () => setTick((tick) => tick + 1)
  useDocPreviewGuestTools({
    previewId: 'preview-1',
    worktreeId: 'wt-1',
    grantId: 'grant-1',
    webviewRef: { current: null },
    containerRef: { current: null },
    toolsReady: true
  } as unknown as Parameters<typeof useDocPreviewGuestTools>[0])
  return null
}

afterEach(() => {
  cleanup()
  browserUuidCalls.count = 0
  bumpRender = null
})

describe('useDocPreviewGuestTools annotation bridge token', () => {
  it('mints the bridge token once per mount, not once per render', () => {
    render(<Host />)
    expect(browserUuidCalls.count).toBe(1)

    for (let i = 0; i < 20; i += 1) {
      act(() => bumpRender?.())
    }

    expect(browserUuidCalls.count).toBe(1)
  })
})
