/** Owns a saved image until terminal delivery begins. */
export function createTerminalImageAttachmentLease({
  isCurrent,
  settle,
  onError
}: {
  isCurrent: () => boolean
  settle: (action: 'discard' | 'retain' | 'release') => Promise<void>
  onError: (error: unknown) => void
}) {
  let canceled = false
  let delivered = false
  let delivery: Promise<void> | undefined
  let discarded = false
  let preparation: Promise<boolean> | undefined
  const discard = () => {
    if (discarded || delivered) {
      return
    }
    discarded = true
    void settle('discard').catch(onError)
  }
  return {
    isCurrent: () => !canceled && isCurrent(),
    prepareDelivery: async () => {
      if (canceled || !isCurrent()) {
        return false
      }
      preparation = settle('retain').then(
        () => true,
        (error) => {
          onError(error)
          return false
        }
      )
      const prepared = await preparation
      if (canceled) {
        discard()
      }
      return prepared && !canceled && isCurrent()
    },
    deliveryStarted: async () => {
      if (canceled) {
        throw new Error('Image preview was canceled')
      }
      delivered = true
      delivery ??= settle('release')
      try {
        await delivery
      } catch (error) {
        delivery = undefined
        delivered = false
        if (canceled) {
          discard()
        }
        throw error
      }
    },
    cancel: () => {
      canceled = true
      if (preparation) {
        void preparation.then(discard)
      } else {
        discard()
      }
    }
  }
}
