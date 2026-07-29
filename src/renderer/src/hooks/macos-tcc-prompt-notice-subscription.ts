export type TccPromptNoticePayload = { promptCount: number }

type TccPromptNoticeClaim = TccPromptNoticePayload & { claimId?: number }

type MacosTccPromptNoticeApi = {
  onThreshold?: (callback: (payload: TccPromptNoticePayload) => void) => () => void
  consumePending?: () => Promise<TccPromptNoticeClaim | null>
  acknowledgePending?: (claimId: number) => Promise<void>
  releasePending?: (claimId: number) => Promise<void>
  dismiss?: () => Promise<void>
}

export async function dismissMacosTccPromptNotice(
  api: Pick<MacosTccPromptNoticeApi, 'dismiss'> | undefined
): Promise<void> {
  try {
    await api?.dismiss?.()
  } catch {
    // Why: renderer teardown must not turn a best-effort dismissal into an unhandled error.
  }
}

export function subscribeToMacosTccPromptNotice(
  api: MacosTccPromptNoticeApi | undefined,
  onNotice: (payload: TccPromptNoticePayload) => void
): () => void {
  const pullPending = (): Promise<TccPromptNoticeClaim | null> => {
    if (!api?.consumePending) {
      return Promise.resolve(null)
    }
    try {
      return api.consumePending()
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const releaseClaim = async (claimId: number): Promise<boolean> => {
    if (!api?.releasePending) {
      return false
    }
    try {
      await api.releasePending(claimId)
      return true
    } catch {
      return false
    }
  }
  const acknowledgeClaim = (claimId: number): void => {
    if (!api?.acknowledgePending) {
      void releaseClaim(claimId)
      return
    }
    try {
      void api.acknowledgePending(claimId).catch(() => {
        void releaseClaim(claimId)
      })
    } catch {
      void releaseClaim(claimId)
    }
  }
  const showNotice = (payload: TccPromptNoticePayload): boolean => {
    try {
      onNotice(payload)
      return true
    } catch (error) {
      console.error('[macos-tcc-prompts] Failed to show notice:', error)
      return false
    }
  }
  // Why: one retry recovers transient toast setup without spinning on a persistent renderer fault.
  let displayRetryAvailable = true
  const consume = (fallback?: TccPromptNoticePayload): void => {
    if (!api?.consumePending) {
      if (fallback) {
        showNotice(fallback)
      }
      return
    }
    void pullPending().then(
      (pending) => {
        if (pending) {
          const claimId = pending.claimId
          if (!showNotice({ promptCount: pending.promptCount })) {
            if (typeof claimId === 'number') {
              const shouldRetry = displayRetryAvailable
              displayRetryAvailable = false
              void releaseClaim(claimId).then((released) => {
                if (released && shouldRetry) {
                  consume()
                }
              })
            }
            return
          }
          if (typeof claimId === 'number') {
            acknowledgeClaim(claimId)
          }
        }
      },
      () => {
        if (fallback) {
          showNotice(fallback)
        }
      }
    )
  }

  const unsubscribe = api?.onThreshold?.((payload) => consume(payload)) ?? (() => {})
  // Why: the threshold can land before React subscribes or while the main window is closed.
  consume()
  // Why: StrictMode cleanup must not abandon a claim before it is acknowledged or released.
  return unsubscribe
}
