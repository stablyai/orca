import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'

type CopyTarget = 'web' | 'pairing'

/** Copy feedback for generated pairing URLs; the reset timer dies with the Settings surface. */
export function useRuntimePairingUrlCopy(mountedRef: { current: boolean }): {
  copiedTarget: CopyTarget | null
  copyGeneratedUrl: (target: CopyTarget, value: string) => Promise<void>
  setContainerNode: (node: HTMLDivElement | null) => void
} {
  const t = useTranslate()
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null)
  const copiedTargetResetTimerRef = useRef<number | null>(null)

  const clearCopiedTargetResetTimer = useCallback((): void => {
    if (copiedTargetResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(copiedTargetResetTimerRef.current)
    copiedTargetResetTimerRef.current = null
  }, [])

  const setContainerNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Cancel surface-owned copy timers when Settings detaches.
      if (!node) {
        clearCopiedTargetResetTimer()
      }
    },
    [clearCopiedTargetResetTimer]
  )

  const copyGeneratedUrl = async (target: CopyTarget, value: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(value)
      if (mountedRef.current) {
        clearCopiedTargetResetTimer()
        setCopiedTarget(target)
        copiedTargetResetTimerRef.current = window.setTimeout(() => {
          copiedTargetResetTimerRef.current = null
          if (mountedRef.current) {
            setCopiedTarget((current) => (current === target ? null : current))
          }
        }, 1400)
        toast.success(
          target === 'web'
            ? t(
                'auto.components.settings.RuntimePairingUrlGenerator.13704d635e',
                'Copied web client URL.'
              )
            : t(
                'auto.components.settings.RuntimePairingUrlGenerator.df0aa45a86',
                'Copied pairing URL.'
              )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : t(
                'auto.components.settings.RuntimePairingUrlGenerator.d6c081adf4',
                'Failed to copy URL.'
              )
        )
      }
    }
  }

  return { copiedTarget, copyGeneratedUrl, setContainerNode }
}
