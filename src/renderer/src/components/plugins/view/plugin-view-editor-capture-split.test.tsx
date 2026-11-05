// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { usePluginEditorCaptureReport } from '@/components/editor/plugin-editor-capture-status'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { captureOpenEditor } from './plugin-view-editor-capture'

const settling = vi.hoisted(() => ({ wait: undefined as (() => Promise<void>) | undefined }))
vi.mock('./plugin-view-panel-settle', () => ({
  waitForColorScheme: async () => settling.wait?.(),
  nextPaintedFrames: async () => undefined
}))

const FILE = '/workspace/document'

function Frame({
  name,
  delivered,
  state = 'ready',
  revision = 'revision'
}: {
  name: string
  delivered: boolean
  state?: 'ready' | 'loading' | 'error'
  revision?: string
}) {
  const load = usePluginViewCaptureStore((state) => state.editorLoads[FILE] ?? 0)
  const progress = usePluginEditorCaptureReport(
    FILE,
    state,
    `orca-plugin-frame://${name}/${revision}.html`,
    `acme.binary/hex:${revision}:${load}`,
    null,
    'acme.binary/hex',
    name
  )
  useEffect(() => {
    if (delivered && state === 'ready') {
      progress('delivered')
      progress('subscribed')
    }
  }, [delivered, state, revision, load, progress])
  return (
    <div
      data-plugin-editor-surface={FILE}
      data-plugin-editor-frame={name}
      data-plugin-editor-frame-key={`acme.binary/hex:${revision}:${load}`}
    >
      <webview
        ref={(element) => {
          if (element) {
            element.getBoundingClientRect = () =>
              DOMRect.fromRect(
                name === 'ready'
                  ? { x: 20, y: 30, width: 640, height: 480 }
                  : { x: 0, y: 0, width: 100, height: 100 }
              )
            Object.assign(element, { getWebContentsId: () => (name === 'ready' ? 42 : 7) })
          }
        }}
      />
    </div>
  )
}

it('captures the split frame that received the selected document', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <>
          <Frame name="pending" delivered={false} />
          <Frame name="ready" delivered />
        </>
      )
    )
    let pending: ReturnType<typeof captureOpenEditor> | undefined
    await act(async () => {
      pending = captureOpenEditor(
        'r',
        FILE,
        { captureId: 'split', timeoutMs: 1000 },
        'acme.binary/hex'
      )
    })
    const reply = await pending
    expect(reply).toMatchObject({
      ok: true,
      panel: {
        rect: { x: 20, y: 30, width: 640, height: 480 },
        guestContentsId: 42,
        guestUrl: 'orca-plugin-frame://ready/revision.html',
        subscribed: true
      }
    })
  } finally {
    await act(async () => root.unmount())
    usePluginViewCaptureStore.getState().end()
    container.remove()
  }
})

it('waits for a pending sibling in the new capture generation after a stale frame failed', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <>
          <Frame name="failed" state="error" delivered={false} />
          <Frame name="ready" delivered={false} />
        </>
      )
    )
    let pending: ReturnType<typeof captureOpenEditor> | undefined
    await act(async () => {
      pending = captureOpenEditor(
        'r',
        FILE,
        { captureId: 'next-generation', timeoutMs: 1000 },
        'acme.binary/hex'
      )
    })
    await act(async () =>
      root.render(
        <>
          <Frame name="failed" state="error" delivered={false} />
          <Frame name="ready" delivered />
        </>
      )
    )
    expect(await pending).toMatchObject({
      ok: true,
      panel: { guestContentsId: 42, guestUrl: 'orca-plugin-frame://ready/revision.html' }
    })
  } finally {
    await act(async () => root.unmount())
    usePluginViewCaptureStore.getState().end()
    container.remove()
  }
})

it('refuses a same-name frame that reloads after delivery and before measurement', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let announce: () => void = () => {}
  let resume: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    announce = resolve
  })
  const released = new Promise<void>((resolve) => {
    resume = resolve
  })
  settling.wait = async () => {
    announce()
    await released
  }
  try {
    await act(async () => root.render(<Frame name="ready" delivered />))
    let pending: ReturnType<typeof captureOpenEditor> | undefined
    await act(async () => {
      pending = captureOpenEditor(
        'r',
        FILE,
        { captureId: 'reload', timeoutMs: 1000 },
        'acme.binary/hex'
      )
    })
    await started
    await act(async () =>
      root.render(<Frame name="ready" revision="replacement" delivered={false} />)
    )
    resume()
    expect(await pending).toMatchObject({ ok: false, code: 'editor_changed_during_capture' })
  } finally {
    settling.wait = undefined
    resume()
    await act(async () => root.unmount())
    usePluginViewCaptureStore.getState().end()
    container.remove()
  }
})
