// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import { RUNTIME_ENVIRONMENT_WAKING_MESSAGE } from '../../../../../shared/remote-runtime/recipe-vm-wake'
import {
  WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS,
  installWindowVisibilitySubscriptionParking
} from './window-visibility-subscription-parking'

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
}

describe('a subscribe refused because the VM is still waking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries at the first delay, not on a backoff grown by earlier failures', async () => {
    // As the IPC hop leaves it: the code is gone, the message stays.
    const waking = new Error(
      `Error invoking remote method 'runtimeEnvironments:subscribe': RemoteRuntimeClientError: ${RUNTIME_ENVIRONMENT_WAKING_MESSAGE}`
    )
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not connect'))
      .mockRejectedValueOnce(new Error('Could not connect'))
      .mockRejectedValueOnce(new Error('Could not connect'))
      .mockRejectedValueOnce(waking)
      .mockResolvedValue({ unsubscribe: vi.fn() })
    const onSubscribeError = vi.fn()
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe, onSubscribeError }])
    await settle()
    // Three ordinary failures: 1 s, 2 s, 4 s.
    for (const ms of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(ms)
      await settle()
    }
    expect(subscribe).toHaveBeenCalledTimes(4)
    expect(onSubscribeError).toHaveBeenLastCalledWith(waking)
    // The waking refusal retries after the first delay (not 8 s).
    await vi.advanceTimersByTimeAsync(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS)
    await settle()
    expect(subscribe).toHaveBeenCalledTimes(5)
    dispose()
  })
})
