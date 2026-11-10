import { Check, CircleAlert, Loader2, Play, Square } from 'lucide-react'
import { DictationGrapes } from '@/components/dictation/DictationGrapes'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
import {
  MICROPHONE_TEST_MAX_SECONDS,
  type VoiceMicrophoneTestHeard,
  type VoiceMicrophoneTestPhase
} from './use-voice-microphone-test'

const clock = (seconds: number): string => {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

type VoiceMicrophoneTestPanelProps = {
  phase: VoiceMicrophoneTestPhase
  heard: VoiceMicrophoneTestHeard | null
  level: number
  modelLabel: string | undefined
  microphoneError: (error: unknown) => string
  onStop: () => void
  onSkip: () => void
  onPlayAgain: () => void
  onTestAgain: () => void
}

export function VoiceMicrophoneTestPanel({
  phase,
  heard,
  level,
  modelLabel,
  microphoneError,
  onStop,
  onSkip,
  onPlayAgain,
  onTestAgain
}: VoiceMicrophoneTestPanelProps): React.JSX.Element | null {
  const t = useTranslate()
  if (phase.kind === 'idle' || phase.kind === 'starting') {
    return null
  }
  const model = { model: modelLabel ?? '' }
  let top: React.ReactNode
  if (phase.kind === 'failed') {
    top = (
      <p className="flex items-center gap-2 text-xs text-destructive" role="alert">
        <CircleAlert className="size-3.5 shrink-0" />
        {microphoneError(phase.error)}
      </p>
    )
  } else if (phase.kind === 'recording') {
    top = (
      <>
        <div className="flex items-center gap-3">
          <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
          <span className="text-xs tabular-nums">
            {t(
              'components.settings.voice.micTest.recording',
              'Recording {{elapsed}} of {{limit}}',
              {
                elapsed: clock(phase.seconds),
                limit: clock(MICROPHONE_TEST_MAX_SECONDS)
              }
            )}
          </span>
          <DictationGrapes level={level} active className="text-foreground" />
          <Button variant="outline" size="xs" className="ml-auto" onClick={onStop}>
            <Square />
            {t('components.settings.voice.micTest.stop', 'Stop')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'components.settings.voice.micTest.hint',
            'Say a sentence the way you normally dictate.'
          )}
        </p>
      </>
    )
  } else if (phase.kind === 'playing') {
    top = (
      <div className="flex items-center gap-3">
        <Play className="size-3.5 shrink-0" />
        <span className="text-xs tabular-nums">
          {t('components.settings.voice.micTest.playing', 'Playing back {{elapsed}}', {
            elapsed: clock(phase.seconds)
          })}
        </span>
        <Progress
          value={phase.total > 0 ? (phase.seconds / phase.total) * 100 : 0}
          className="h-1 min-w-24 flex-1"
        />
        <Button variant="ghost" size="xs" onClick={onSkip}>
          {t('components.settings.voice.micTest.skip', 'Skip')}
        </Button>
      </div>
    )
  } else {
    top = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {phase.heardSpeech ? (
          <Check className="size-3.5 shrink-0 text-status-success" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-status-warning" />
        )}
        <span className="text-xs font-medium">
          {phase.heardSpeech
            ? t('components.settings.voice.micTest.levelGood', 'Level looks good')
            : t(
                'components.settings.voice.micTest.levelQuiet',
                'Very quiet. Check the microphone or move closer.'
              )}
        </span>
        <span className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={onPlayAgain}>
            <Play />
            {t('components.settings.voice.micTest.playAgain', 'Play again')}
          </Button>
          <Button variant="outline" size="xs" onClick={onTestAgain}>
            {t('components.settings.voice.micTest.testAgain', 'Test again')}
          </Button>
        </span>
      </div>
    )
  }

  let heardLine: React.ReactNode = null
  if (heard?.kind === 'listening') {
    heardLine = (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
        {t('components.settings.voice.micTest.listening', '{{model}} is listening too…', model)}
      </p>
    )
  } else if (heard?.kind === 'heard') {
    heardLine = (
      <div className="space-y-0.5 rounded-md bg-muted/60 px-3 py-2">
        <p className="text-2xs text-muted-foreground">
          {t('components.settings.voice.micTest.heardLabel', '{{model}} heard', model)}
        </p>
        <p className="text-sm">
          {heard.text ||
            t('components.settings.voice.micTest.heardNothing', 'No words. Try speaking louder.')}
        </p>
      </div>
    )
  } else if (heard?.kind === 'failed') {
    heardLine = (
      <p className="text-xs text-muted-foreground">
        {t(
          'components.settings.voice.micTest.heardFailed',
          '{{model}} couldn’t transcribe the recording.',
          model
        )}
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
      {top}
      {phase.kind === 'playing' || phase.kind === 'done' ? heardLine : null}
    </div>
  )
}
