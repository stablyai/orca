import { useEffect, useRef, useState } from 'react'
import { Loader2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const REMOVE_PENDING_FEEDBACK_DELAY_MS = 200

type RemoveIntegrationButtonProps = {
  integrationName: string
  scopeLabel: string
  onRemove: () => Promise<void>
}

export function RemoveIntegrationButton({
  integrationName,
  scopeLabel,
  onRemove
}: RemoveIntegrationButtonProps): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const mountedRef = useMountedRef()
  const requestPendingRef = useRef(false)
  const [removing, setRemoving] = useState(false)
  const [showPendingFeedback, setShowPendingFeedback] = useState(false)

  useEffect(() => {
    if (!removing) {
      setShowPendingFeedback(false)
      return
    }
    const timer = window.setTimeout(
      () => setShowPendingFeedback(true),
      REMOVE_PENDING_FEEDBACK_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [removing])

  const handleRemove = async (): Promise<void> => {
    if (requestPendingRef.current) {
      return
    }
    requestPendingRef.current = true
    const confirmed = await confirm({
      title: translate(
        'auto.components.settings.RemoveIntegrationButton.title',
        'Remove {{value0}} integration?',
        { value0: integrationName }
      ),
      description: translate(
        'auto.components.settings.RemoveIntegrationButton.description',
        'Orca will delete its saved credentials for this integration from {{value0}}. Credentials issued by {{value1}} will not be revoked.',
        { value0: scopeLabel, value1: integrationName }
      ),
      confirmLabel: translate('auto.components.settings.RemoveIntegrationButton.confirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!confirmed || !mountedRef.current) {
      requestPendingRef.current = false
      return
    }

    setRemoving(true)
    try {
      await onRemove()
      toast.success(
        translate(
          'auto.components.settings.RemoveIntegrationButton.success',
          '{{value0}} integration removed.',
          { value0: integrationName }
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.RemoveIntegrationButton.failure',
          'Could not remove the {{value0}} integration.',
          { value0: integrationName }
        ),
        error instanceof Error ? { description: error.message } : undefined
      )
    } finally {
      requestPendingRef.current = false
      if (mountedRef.current) {
        setRemoving(false)
      }
    }
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      disabled={removing}
      aria-busy={removing}
      onClick={() => void handleRemove()}
    >
      {showPendingFeedback ? <Loader2 className="animate-spin" /> : <Unlink />}
      {translate('auto.components.settings.RemoveIntegrationButton.action', 'Remove')}
    </Button>
  )
}
