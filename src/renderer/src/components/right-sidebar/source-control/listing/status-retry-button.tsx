import React, { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const STATUS_RETRY_TIMEOUT_MS = 15_000

export function StatusRetryButton({
  onRetry
}: {
  onRetry: (signal: AbortSignal) => Promise<void>
}): React.JSX.Element {
  const [isRetrying, setIsRetrying] = useState(false)
  const [showSpinner, setShowSpinner] = useState(false)
  const retryControllerRef = useRef<AbortController | null>(null)
  const isMountedRef = useRef(false)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      retryControllerRef.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!isRetrying) {
      setShowSpinner(false)
      return
    }
    const timer = window.setTimeout(() => setShowSpinner(true), 1_000)
    return () => window.clearTimeout(timer)
  }, [isRetrying])

  const handleRetry = async (): Promise<void> => {
    if (isRetrying) {
      return
    }
    const controller = new AbortController()
    retryControllerRef.current = controller
    const timeout = window.setTimeout(() => controller.abort(), STATUS_RETRY_TIMEOUT_MS)
    setIsRetrying(true)
    try {
      await onRetry(controller.signal)
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }
      // Report retry failures without leaving the warning unusable through an unhandled click rejection.
      console.warn('[SourceControl] status retry failed', error)
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControl.97e7124eac',
          'Could not refresh Source Control. Try again.'
        )
      )
    } finally {
      window.clearTimeout(timeout)
      if (retryControllerRef.current === controller) {
        retryControllerRef.current = null
      }
      if (isMountedRef.current) {
        setIsRetrying(false)
      }
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={isRetrying}
      onClick={() => void handleRetry()}
    >
      {showSpinner ? <Loader2 className="size-3 animate-spin" /> : null}
      {translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
    </Button>
  )
}
