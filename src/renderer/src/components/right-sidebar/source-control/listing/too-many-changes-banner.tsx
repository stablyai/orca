import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const CAPPED_STATUS_RETRY_TIMEOUT_MS = 15_000

export function TooManyChangesBanner({
  limit,
  onRetry
}: {
  limit: number
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
    const timeout = window.setTimeout(() => controller.abort(), CAPPED_STATUS_RETRY_TIMEOUT_MS)
    setIsRetrying(true)
    try {
      await onRetry(controller.signal)
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }
      // Why: a failed local/SSH retry must leave the capped warning usable
      // instead of becoming an unhandled click rejection.
      console.warn('[SourceControl] capped status retry failed', error)
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
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 text-xs text-foreground">
          {translate(
            'auto.components.right.sidebar.SourceControl.tooManyChanges',
            'Too many changes detected. Only the first {{value0}} are shown.',
            { value0: limit.toLocaleString() }
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-24 shrink-0 text-xs"
          disabled={isRetrying}
          onClick={() => void handleRetry()}
        >
          {showSpinner ? <Loader2 className="size-3 animate-spin" /> : null}
          {translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
        </Button>
      </div>
    </div>
  )
}
