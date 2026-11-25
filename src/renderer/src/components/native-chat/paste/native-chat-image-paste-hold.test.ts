import { expect, it } from 'vitest'
import { holdingPendingImageSave } from './native-chat-image-paste-hold'

// Settling, releasing, draining and routing the notice share one continuation: work queued while the
// chip leaves its draft (such as a draft move) runs only after the notice was routed.
it('runs the after-save step in the continuation that settles the save', async () => {
  const order: string[] = []
  await holdingPendingImageSave(
    null,
    async () => 'saved',
    () => {
      queueMicrotask(() => order.push('move'))
      return true
    },
    () => order.push('notice')
  )
  expect(order).toEqual(['notice', 'move'])
})
