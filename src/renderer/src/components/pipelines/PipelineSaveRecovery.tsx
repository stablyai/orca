import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function PipelineSaveRecovery({
  busy,
  onRecover
}: {
  busy: boolean
  onRecover: () => void
}) {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {t(
          'pipelines.saveRejectedMeaning',
          'The save was refused. Your text is retained. Create a new draft from it to continue without overwriting the changed server draft.'
        )}
      </p>
      <Button variant="outline" disabled={busy} onClick={onRecover}>
        {t('pipelines.recoverSaveCopy', 'Create a draft from my retained text')}
      </Button>
    </div>
  )
}
