// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'
import { requestLazyChunkRecoveryReload } from './lazy-chunk-recovery-reload'

describe('requestLazyChunkRecoveryReload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses the reload when the staged checkpoint never reaches disk', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)

    await expect(
      requestLazyChunkRecoveryReload(window, () =>
        Promise.reject(new Error('Failed to persist renderer state before unload.'))
      )
    ).resolves.toBe('checkpoint-refused')

    expect(reload).not.toHaveBeenCalled()
  })

  it('navigates only after the checkpoint is durably written', async () => {
    const order: string[] = []
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      order.push('reload')
      // A real landed reload destroys the document; veto so the wait settles.
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })

    await expect(
      requestLazyChunkRecoveryReload(window, async () => {
        order.push('flushed')
      })
    ).resolves.toBe('unload-vetoed')

    expect(order).toEqual(['flushed', 'reload'])
  })
})
