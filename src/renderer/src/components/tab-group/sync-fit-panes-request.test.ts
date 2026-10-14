// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { queueSyncFitPanes } from './sync-fit-panes-request'

describe('queueSyncFitPanes', () => {
  it('coalesces every request of a tick into one dispatch, then accepts the next', async () => {
    const onSync = vi.fn()
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSync)

    queueSyncFitPanes()
    queueSyncFitPanes()
    queueSyncFitPanes()
    expect(onSync).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(onSync).toHaveBeenCalledTimes(1)

    queueSyncFitPanes()
    await Promise.resolve()
    expect(onSync).toHaveBeenCalledTimes(2)

    window.removeEventListener(SYNC_FIT_PANES_EVENT, onSync)
  })
})
