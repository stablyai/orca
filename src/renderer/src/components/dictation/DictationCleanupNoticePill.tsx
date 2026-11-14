import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { DictationPillCloseButton } from './DictationPillFailure'
import { DictationPillShell } from './DictationPillShell'
import { openVoiceSettings } from './dictation-toasts'
import type { DictationCleanupNotice } from './use-dictation-cleanup'

/** After the words landed as heard because cleanup failed or took too long; closes itself. */
export function DictationCleanupNoticePill({
  notice,
  onClose
}: {
  notice: DictationCleanupNotice
  onClose: () => void
}) {
  const t = useTranslate()
  const message =
    notice.kind === 'timed-out'
      ? t(
          'components.dictation.cleanupNotice.timedOut',
          'Cleanup took too long. Inserted as heard.'
        )
      : t('components.dictation.cleanupNotice.failed', 'Cleanup failed. Inserted as heard.')
  return (
    <DictationPillShell
      anchor={notice.anchor}
      testId="dictation-cleanup-notice"
      className="border-status-warning-border"
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </span>
      <DictationPillCloseButton
        label={t('components.dictation.cleanupNotice.dismiss', 'Dismiss')}
        onClick={onClose}
      />
      <CircleAlert aria-hidden className="size-4 shrink-0 text-status-warning" />
      <span aria-hidden className="min-w-0 flex-1 truncate">
        {message}
      </span>
      {notice.kind === 'failed' ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            onClose()
            openVoiceSettings()
          }}
        >
          {t('auto.components.dictation.DictationPillFailure.openSettings', 'Open settings')}
        </Button>
      ) : null}
    </DictationPillShell>
  )
}
