import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from '../../../shared/editor-save-events'
import { ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT } from '../../../shared/renderer-shutdown-events'
import { installApi } from './web-preload-api-test-harness'

// The harness window stubs event methods with bare vi.fn(); relaunch runs the
// real restart preparation, so give it a live event target to dispatch through.
function wireRealEventTarget(win: Window & typeof globalThis): EventTarget {
  const target = new EventTarget()
  Object.assign(win, {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target)
  })
  return target
}

function hotExitDetail(event: Event): EditorPrepareHotExitDetail {
  return (event as CustomEvent<EditorPrepareHotExitDetail>).detail
}

describe('web preload relaunch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('backs dirty editor buffers up before reloading the document', async () => {
    const { api, window: win } = await installApi()
    wireRealEventTarget(win)
    const order: string[] = []
    win.addEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, (event) => {
      const detail = hotExitDetail(event)
      detail.claim()
      order.push('hot-exit-backup')
      detail.resolve()
    })
    ;(win.location.reload as Mock).mockImplementation(() => order.push('reload'))

    await api.app.relaunch()

    expect(order).toEqual(['hot-exit-backup', 'reload'])
  })

  it('never reloads when the hot-exit backup refuses', async () => {
    const { api, window: win } = await installApi()
    wireRealEventTarget(win)
    win.addEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, (event) => {
      const detail = hotExitDetail(event)
      detail.claim()
      detail.reject('editor backup failed')
    })

    await expect(api.app.relaunch()).rejects.toThrow('editor backup failed')
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('never reloads when the shutdown checkpoint reports a failure', async () => {
    const { api, window: win } = await installApi()
    wireRealEventTarget(win)
    win.addEventListener('beforeunload', (event) => {
      win.dispatchEvent(new Event(ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT))
      event.preventDefault()
    })

    await expect(api.app.relaunch()).rejects.toThrow(
      'Renderer shutdown checkpoint was not completed.'
    )
    expect(win.location.reload).not.toHaveBeenCalled()
  })
})
