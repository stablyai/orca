import { useEffect } from 'react'
import { Check, CircleAlert, Download, Mic } from 'lucide-react'
import { Trans } from 'react-i18next'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../terminal-pane/input/keyboard/agent-interrupt-key-event'
import type { DictationPillAnchor } from './dictation-pill-anchor'
import { DictationPillCloseButton } from './DictationPillFailure'
import { DictationPillShell } from './DictationPillShell'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'
import { useSpeechModelUpdateDownload } from './use-speech-model-update-download'

const DONE_AUTO_HIDE_MS = 4000

/** Esc closes the pill, except mid-download so it can still reach the terminal or agent underneath. */
function useEscCloses(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isImeOwnedKeyboardEvent(event) && isPlainEscapeKeyEvent(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    addAppKeyListener('keydown', handleKeyDown, { first: true })
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [active, onClose])
}

/** Shown instead of recording when the selected model needs a download for the current speech engine. */
export function DictationSetupPill({
  target,
  anchor,
  onClose
}: {
  target: SpeechModelUpdateTarget
  anchor: DictationPillAnchor | null
  onClose: () => void
}) {
  const t = useTranslate()
  const shortcut = useShortcutKeyDetails('voice.dictation')
  const download = useSpeechModelUpdateDownload(target, onClose)
  const { phase, percent } = download
  const retired = Boolean(target.retired)

  useEscCloses(phase !== 'downloading', onClose)

  useEffect(() => {
    if (phase !== 'done' || retired) {
      return
    }
    const timer = window.setTimeout(onClose, DONE_AUTO_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [phase, retired, onClose])

  const dismissLabel = t('speechModelUpdate.pill.dismiss', 'Dismiss')
  let icon: React.ReactNode
  let message: React.ReactNode
  let announced: string
  let actions: React.ReactNode = null
  let closeLabel = dismissLabel
  let close = onClose

  if (phase === 'downloading') {
    icon = <Download className="size-4 shrink-0 text-muted-foreground" />
    announced = t('speechModelUpdate.pill.downloading', 'Setting up dictation')
    closeLabel = t('speechModelUpdate.pill.cancelDownload', 'Cancel download')
    close = () => {
      download.cancel()
      onClose()
    }
    message = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate">{announced}</span>
            <Progress value={percent} className="h-1 min-w-12 flex-1" />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('speechModelUpdate.pill.downloadingTooltip', '{{done}} of {{size}} MB', {
            done: download.doneMb,
            size: download.totalMb
          })}
        </TooltipContent>
      </Tooltip>
    )
  } else if (phase === 'done') {
    icon = <Check className="size-4 shrink-0 text-status-success" strokeWidth={2.5} />
    announced = t('speechModelUpdate.pill.readyNoShortcut', 'Dictation is ready.')
    message =
      shortcut.keys.length > 0 ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <Trans
            i18n={i18n}
            defaults={t('speechModelUpdate.pill.ready', 'Dictation is ready. Press <kbd></kbd>')}
            components={{
              kbd: <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
            }}
          />
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{announced}</span>
      )
    actions = retired ? (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={download.deleting}
        onClick={download.deleteRetired}
      >
        {t('speechModelUpdate.pill.deleteOld', 'Delete old model')}
      </Button>
    ) : null
  } else if (phase === 'failed') {
    icon = <CircleAlert className="size-4 shrink-0 text-destructive" />
    announced = t('speechModelUpdate.pill.failed', 'Download stopped. Check your connection.')
    message = <span className="min-w-0 flex-1 truncate">{announced}</span>
    actions = (
      <Button type="button" size="xs" onClick={download.start}>
        {t('speechModelUpdate.pill.tryAgain', 'Try again')}
      </Button>
    )
  } else {
    icon = <Mic className="size-4 shrink-0 text-muted-foreground" />
    announced = retired
      ? t('speechModelUpdate.pill.retiredNotice', 'Dictation moved to a faster speech model')
      : t('speechModelUpdate.pill.updateNotice', 'Faster dictation is ready to install')
    message = <span className="min-w-0 flex-1 truncate">{announced}</span>
    actions = (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" size="xs" onClick={download.start}>
            {t('speechModelUpdate.pill.install', 'Install')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('speechModelUpdate.pill.installTooltip', 'One-time download · {{size}} MB', {
            size: download.totalMb
          })}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DictationPillShell
      anchor={anchor}
      testId="dictation-setup-pill"
      className={phase === 'failed' ? 'border-destructive/40 pl-3' : 'pl-3'}
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </span>
      {icon}
      <span aria-hidden className="flex min-w-0 flex-1 items-center">
        {message}
      </span>
      {actions}
      <DictationPillCloseButton label={closeLabel} onClick={close} />
    </DictationPillShell>
  )
}
