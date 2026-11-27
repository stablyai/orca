// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireWebviewsDragPassthrough } from '../../browser-pane/host-guest/drag/webview-drag-passthrough'
import { setWebviewsDragPassthrough } from '../../browser-pane/host-guest/webview-registry'
import { PluginFrameView, type PluginFrameElement } from './plugin-frame-element'

const heldReleases: (() => void)[] = []

function acquireTabDrag(): () => void {
  const release = acquireWebviewsDragPassthrough()
  heldReleases.push(release)
  return release
}

afterEach(() => {
  cleanup()
  // Why: passthrough tokens are module state; a failed assertion must not leak them into later tests.
  for (const release of heldReleases.splice(0)) {
    release()
  }
  setWebviewsDragPassthrough(false)
})

function renderFrame(guest: { partition: string; url: string } | null): HTMLElement {
  const frameRef: { current: PluginFrameElement | null } = { current: null }
  render(
    <PluginFrameView
      frameRef={frameRef}
      guest={guest}
      srcDoc="<p>plugin</p>"
      name="plugin-frame"
      title="Plugin editor"
      onLoad={() => {}}
    />
  )
  if (!frameRef.current) {
    throw new Error('frame not mounted')
  }
  return frameRef.current
}

describe('PluginFrameView tab-drag passthrough', () => {
  it.each([
    ['iframe', null],
    ['webview', { partition: 'persist:plugin', url: 'orca-plugin://frame' }]
  ])('lets a tab drag pass over the %s and restores it on release', (_kind, guest) => {
    const frame = renderFrame(guest)
    expect(frame.style.pointerEvents).toBe('')

    let release: () => void = () => {}
    act(() => {
      release = acquireTabDrag()
    })
    expect(frame.style.pointerEvents).toBe('none')

    act(() => release())
    expect(frame.style.pointerEvents).toBe('')
  })

  it('leaves native drags (Orca file paths) to the plugin frame', () => {
    const frame = renderFrame(null)

    act(() => setWebviewsDragPassthrough(true))
    expect(frame.style.pointerEvents).toBe('')

    let release: () => void = () => {}
    act(() => {
      release = acquireTabDrag()
    })
    expect(frame.style.pointerEvents).toBe('none')

    act(() => release())
    expect(frame.style.pointerEvents).toBe('')
  })
})
