// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import {
  installWindowVisibilitySubscriptionParking,
  type WindowVisibilitySubscriptionContext
} from './window-visibility-subscription-parking'

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('a stream the host ends while the window stays visible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('unsubscribes a stream that ends before its subscribe settles', async () => {
    let resolveHandle = (_handle: { unsubscribe: () => void }): void => {}
    const unsubscribe = vi.fn()
    const contexts: WindowVisibilitySubscriptionContext[] = []
    const subscribe = vi
      .fn()
      .mockImplementationOnce(
        (_isCurrent: () => boolean, context: WindowVisibilitySubscriptionContext) => {
          contexts.push(context)
          return new Promise((resolve) => {
            resolveHandle = resolve
          })
        }
      )
      .mockResolvedValue({ unsubscribe: vi.fn() })
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe }])

    contexts[0]!.ended()
    resolveHandle({ unsubscribe })
    await settle()

    expect(unsubscribe).toHaveBeenCalled()
    dispose()
  })
})
