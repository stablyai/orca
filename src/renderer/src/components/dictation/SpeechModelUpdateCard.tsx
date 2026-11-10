import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Download, Mic, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import {
  findSpeechModelUpdateTarget,
  type SpeechModelUpdateTarget
} from './speech-model-update-target'

const DONE_AUTO_HIDE_MS = 4000

function useSpeechModelUpdateTarget(): SpeechModelUpdateTarget | null {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.speechModelUpdateNoticeSeen)
  const voice = useAppStore((s) => s.settings?.voice)
  const [target, setTarget] = useState<SpeechModelUpdateTarget | null>(null)

  useEffect(() => {
    // Why skip paired web clients: the models live on the host, whose own window shows this.
    if (seen || !voice || isPairedWebClientWindow()) {
      return
    }
    let cancelled = false
    void Promise.all([window.api.speech.getCatalog(), window.api.speech.getModelStates()])
      .then(([catalog, states]) => {
        if (cancelled) {
          return
        }
        const store = useAppStore.getState()
        store.setModelStates(states)
        setTarget(findSpeechModelUpdateTarget(voice, catalog, states))
        // Why mark on the first check, shown or not: the card is for the first launch after the engine change.
        store.markSpeechModelUpdateNoticeSeen()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [seen, voice])

  return target
}

/** One-time card offering the download the transcribe-cpp engine needs for the selected model. */
export function SpeechModelUpdateCard(): React.JSX.Element | null {
  const target = useSpeechModelUpdateTarget()
  const [closed, setClosed] = useState(false)
  const close = useCallback(() => setClosed(true), [])
  if (!target || closed) {
    return null
  }
  return <SpeechModelUpdateCardBody target={target} onClose={close} />
}

function SpeechModelUpdateCardBody({
  target: { model, retired },
  onClose
}: {
  target: SpeechModelUpdateTarget
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useAppStore((s) => s.modelStates.find((m) => m.id === model.id))
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const [failedAtMb, setFailedAtMb] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const lastMbRef = useRef(0)

  // The Settings row starts the same download, so both follow the shared model states.
  useEffect(
    () => window.api.speech.onDownloadProgress(() => void refreshModelStates()),
    [refreshModelStates]
  )

  const totalMb = Math.round((model.sizeBytes ?? 0) / 1_000_000)
  const downloading = state?.status === 'downloading' || state?.status === 'extracting'
  const percent = Math.round((state?.progress ?? 0) * 100)
  const doneMb = Math.round((state?.progress ?? 0) * totalMb)
  const phase = downloading
    ? 'downloading'
    : state?.status === 'ready'
      ? 'done'
      : failedAtMb !== null
        ? 'failed'
        : 'notice'

  useEffect(() => {
    if (downloading) {
      lastMbRef.current = doneMb
    }
  }, [downloading, doneMb])

  useEffect(() => {
    if (phase !== 'done' || retired) {
      return
    }
    const timer = window.setTimeout(onClose, DONE_AUTO_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [phase, retired, onClose])

  const startDownload = (): void => {
    setFailedAtMb(null)
    lastMbRef.current = 0
    void window.api.speech
      .downloadModel(model.id)
      .catch(() => setFailedAtMb(lastMbRef.current))
      .finally(() => void refreshModelStates())
  }

  const deleteRetired = (): void => {
    if (!retired) {
      return
    }
    setDeleting(true)
    void window.api.speech
      .deleteModel(retired.id)
      .then(() => {
        void refreshModelStates()
        onClose()
      })
      .catch(() => {
        setDeleting(false)
        toast.error(
          t('speechModelUpdate.deleteFailed', 'Failed to delete {{model}}.', {
            model: retired.label
          })
        )
      })
  }

  const names = { model: model.label, old: retired?.label ?? '', size: totalMb }
  const later = (
    <Button variant="ghost" size="sm" onClick={onClose}>
      {t('speechModelUpdate.later', 'Later')}
    </Button>
  )
  let icon = <Mic className="size-4" />
  let title: string
  let description: string
  let actions: React.ReactNode = null

  if (phase === 'downloading') {
    icon = <Download className="size-4" />
    title = retired
      ? t('speechModelUpdate.downloadingTitle', 'Downloading {{model}}', names)
      : t('speechModelUpdate.updatingTitle', 'Updating {{model}}', names)
    description = t(
      'speechModelUpdate.downloadingDescription',
      'You can keep working. Dictation is back when this finishes.'
    )
    actions = (
      <Button
        variant="ghost"
        size="sm"

        onClick={() => void window.api.speech.cancelDownload(model.id)}
      >
        {t('speechModelUpdate.cancel', 'Cancel')}
      </Button>
    )
  } else if (phase === 'done') {
    icon = <Check className="size-4 text-status-success" />
    title = t('speechModelUpdate.doneTitle', 'Dictation is ready')
    description = retired
      ? t(
          'speechModelUpdate.doneRetiredDescription',
          '{{model}} is set up. The old {{old}} files are still on disk.',
          names
        )
      : t(
          'speechModelUpdate.doneDescription',
          '{{model}} is updated. The old files were removed.',
          names
        )
    actions = retired ? (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('speechModelUpdate.keep', 'Keep')}
        </Button>
        <Button
          variant="outline"
          size="sm"

          disabled={deleting}
          onClick={deleteRetired}
        >
          {t('speechModelUpdate.deleteOld', 'Delete old model')}
        </Button>
      </>
    ) : null
  } else if (phase === 'failed') {
    icon = <CircleAlert className="size-4 text-destructive" />
    title = retired
      ? t('speechModelUpdate.downloadFailedTitle', "Couldn't download {{model}}", names)
      : t('speechModelUpdate.updateFailedTitle', "Couldn't update {{model}}", names)
    description = failedAtMb
      ? t(
          'speechModelUpdate.failedAtDescription',
          'The download stopped at {{mb}} MB. Check your connection and try again.',
          { mb: failedAtMb }
        )
      : t(
          'speechModelUpdate.failedDescription',
          'The download stopped. Check your connection and try again.'
        )
    actions = (
      <>
        {later}
        <Button size="sm" onClick={startDownload}>
          {t('speechModelUpdate.tryAgain', 'Try again')}
        </Button>
      </>
    )
  } else {
    title = retired
      ? t('speechModelUpdate.replacedTitle', 'Your speech model was replaced')
      : t('speechModelUpdate.updateTitle', 'Update your speech model')
    description = retired
      ? t(
          'speechModelUpdate.replacedDescription',
          "{{old}} can't run on the new speech engine. {{model}} replaces it ({{size}} MB).",
          names
        )
      : t(
          'speechModelUpdate.updateDescription',
          'Dictation now runs on a faster engine. {{model}} needs a one-time download ({{size}} MB) before you can dictate again.',
          names
        )
    actions = (
      <>
        {later}
        <Button size="sm" onClick={startDownload}>
          {retired
            ? t('speechModelUpdate.downloadReplacement', 'Download {{model}}', names)
            : t('speechModelUpdate.update', 'Update')}
        </Button>
      </>
    )
  }

  return (
    <Card size="sm" role="complementary" aria-labelledby="speech-model-update-title">
      <div className="flex flex-col gap-2.5 px-3 py-0.5">
        <div className="flex items-start gap-2.5">
          <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted">{icon}</div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
            <h3 id="speech-model-update-title" className="text-sm font-semibold">
              {title}
            </h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={onClose}
            aria-label={t('speechModelUpdate.dismiss', 'Dismiss')}
          >
            <X />
          </Button>
        </div>
        {phase === 'downloading' && (
          <div className="flex flex-col gap-1.5">
            <Progress value={percent} className="h-1" />
            <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>
                {t('speechModelUpdate.progress', '{{done}} of {{total}} MB', {
                  done: doneMb,
                  total: totalMb
                })}
              </span>
              <span>{percent}%</span>
            </div>
          </div>
        )}
        {actions && <div className="flex flex-wrap justify-end gap-1.5">{actions}</div>}
      </div>
    </Card>
  )
}
