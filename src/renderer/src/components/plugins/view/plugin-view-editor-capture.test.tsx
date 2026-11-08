// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginEditorCaptureReport } from '@/components/editor/plugin-editor-capture-status'
import { registerEditorFrameFlush } from '@/components/editor/save/flush/editor-pending-flush'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import { captureOpenEditor } from './plugin-view-editor-capture'

vi.mock('./plugin-view-panel-settle', () => ({
  nextPaintedFrames: async () => undefined,
  waitForColorScheme: async () => undefined
}))

const FILE = '/w/a.sketch'

/** Stands in for PluginCustomEditorFrame: reports this file's frame, keyed by the capture load. */
function Frame(): React.JSX.Element {
  const load = usePluginViewCaptureStore((state) => state.editorLoads[FILE] ?? 0)
  usePluginEditorCaptureReport(FILE, 'ready', 'orca-plugin-frame://x/e.html', `k:${load}`)
  return (
    <div data-plugin-editor-surface={FILE}>
      <webview
        ref={(element) => {
          if (element) {
            element.getBoundingClientRect = () =>
              DOMRect.fromRect({ x: 5, y: 6, width: 300, height: 200 })
            Object.assign(element, { getWebContentsId: () => 42 })
          }
        }}
      />
    </div>
  )
}

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Frame />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  usePluginViewCaptureStore.getState().end()
  vi.useRealTimers()
})

describe('an editor capture', () => {
  it('flushes the open editor before reloading it, and refuses the shot when that fails', async () => {
    const unregister = registerEditorFrameFlush(FILE, async () => false)
    const loadsBefore = usePluginViewCaptureStore.getState().editorLoads[FILE]
    try {
      const reply = await captureOpenEditor('r', FILE, { captureId: 'c', timeoutMs: 1_000 })
      expect(reply).toMatchObject({ ok: false, code: 'editor_flush_failed' })
      // Not reloaded, so its unflushed edits are still in the frame.
      expect(usePluginViewCaptureStore.getState().editorLoads[FILE]).toBe(loadsBefore)
    } finally {
      unregister()
    }
  })
})
