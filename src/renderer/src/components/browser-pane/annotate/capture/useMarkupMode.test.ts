// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useMarkupMode, type MarkupCaptureContext } from './useMarkupMode'
import { useLocalPageDraw } from './use-local-page-draw'
import { useGrabMode, type GrabModeState } from '../grab/useGrabMode'
import type { BrowserGuestAnnotationViewportBridge } from '../use-browser-guest-annotate-tools'
import type { BrowserGuestToolsTransport } from '../browser-guest-tools-transport'
import type { BrowserSetGrabModeResult } from '../../../../../../shared/browser/element-grab/browser-grab-types'

const page = vi.hoisted(() => ({
  captures: [] as { finish: (ok: boolean) => void }[],
  errors: 0
}))
vi.mock('./markup-base-image', () => ({
  captureMarkupBaseImage: () =>
    new Promise((resolve, reject) =>
      page.captures.push({
        finish: (ok) =>
          ok
            ? resolve({ dataUrl: 'data:image/png;base64,', width: 1, height: 1 })
            : reject(new Error('no capture'))
      })
    )
}))
vi.mock('sonner', () => ({ toast: { error: () => (page.errors += 1) } }))

const captureContext = (): MarkupCaptureContext => ({
  source: { kind: 'clean-page', browserPageId: 'page-1' },
  cssWidth: 1,
  cssHeight: 1,
  outputScale: 1
})
const useMarkup = (): ReturnType<typeof useMarkupMode> =>
  useMarkupMode({ getCaptureContext: captureContext, onDeliver: () => {} })
const finishCapture = (ok: boolean): Promise<void> =>
  act(async () => {
    page.captures.shift()!.finish(ok)
  })

beforeEach(() => {
  page.captures.length = 0
  page.errors = 0
})

it('a capture its tab closed or its page replaced never opens or reports an error; a drawing survives abandon', async () => {
  const closed = renderHook(useMarkup)
  act(() => void closed.result.current.start())
  closed.unmount()
  await finishCapture(false)
  expect(page.errors).toBe(0)

  const { result } = renderHook(useMarkup)
  act(() => void result.current.start())
  act(() => result.current.abandonCapture())
  await finishCapture(true)
  expect(result.current.state).toBe('idle')

  act(() => void result.current.start())
  await finishCapture(true)
  expect(result.current.state).toBe('drawing')
  act(() => result.current.abandonCapture())
  expect(result.current.state).toBe('drawing')
  expect(page.errors).toBe(0)
})

it('local Draw stops an armed picker first, and drops its capture on a reload or a hidden pane', async () => {
  const order: string[] = []
  const invalidateDocument = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Draw path reads only invalidateDocument from the bridge.
  const bridge = { invalidateDocument } as unknown as BrowserGuestAnnotationViewportBridge
  const { result, rerender } = renderHook(
    ({ grabState, isActive }: { grabState: GrabModeState; isActive: boolean }) => {
      const markup = useMarkup()
      const draw = useLocalPageDraw({
        markup,
        grabState,
        stopPicker: () => order.push('stop'),
        isActive,
        viewportBridge: bridge
      })
      return { markup, draw }
    },
    { initialProps: { grabState: 'armed', isActive: true } }
  )

  act(() => void result.current.draw.startMarkup().then(() => order.push('settled')))
  expect(order).toEqual(['stop'])
  act(() => result.current.draw.viewportBridge.invalidateDocument())
  expect(invalidateDocument).toHaveBeenCalledOnce()
  await finishCapture(false)
  expect(result.current.markup.state).toBe('idle')

  rerender({ grabState: 'idle', isActive: true })
  act(() => void result.current.draw.startMarkup())
  rerender({ grabState: 'idle', isActive: false })
  await finishCapture(false)
  expect(result.current.markup.state).toBe('idle')
  expect(page.errors).toBe(0)

  rerender({ grabState: 'idle', isActive: true })
  act(() => void result.current.draw.startMarkup())
  await finishCapture(true)
  expect(result.current.markup.state).toBe('drawing')
  expect(order).toEqual(['stop', 'settled'])
})

it('a stale enable reply sends no second off, and a superseded enable never starts a pick', async () => {
  const replies: ((result: BrowserSetGrabModeResult) => void)[] = []
  const sent: string[] = []
  const transport = {
    setGrabMode: ({ enabled }: { enabled: boolean }) => {
      sent.push(enabled ? 'on' : 'off')
      return enabled
        ? new Promise((resolve) => replies.push(resolve))
        : Promise.resolve({ ok: true })
    },
    cancelGrab: async () => {
      sent.push('cancel')
      return true
    },
    awaitGrabSelection: () => {
      sent.push('await')
      return new Promise(() => {})
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: arming and cancelling use only these three calls.
  } as unknown as BrowserGuestToolsTransport
  vi.stubGlobal('api', { browser: { onGuestEscape: () => () => {} } })
  const { result } = renderHook(() => useGrabMode('page-1', transport))

  act(() => result.current.toggle())
  act(() => result.current.cancel())
  await act(async () => replies.shift()!({ ok: true, superseded: true }))
  expect(sent).toEqual(['on', 'off'])

  act(() => result.current.toggle())
  await act(async () => replies.shift()!({ ok: true, superseded: true }))
  expect(sent).toEqual(['on', 'off', 'on'])
  expect(result.current.state).toBe('idle')
  vi.unstubAllGlobals()
})
