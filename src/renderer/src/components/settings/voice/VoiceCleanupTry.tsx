import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { captureDictationContext } from '@/components/dictation/dictation-context'
import {
  isDictationCleanupOn,
  type DictationCleanupResult
} from '../../../../../shared/dictation-cleanup'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { Button } from '../../ui/button'

/** The microphone test's one way to try cleanup on what the model heard, with the real wait. */
export function VoiceCleanupTry({ text }: { text: string }): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const on = settings ? isDictationCleanupOn(settings) : false
  const [result, setResult] = useState<DictationCleanupResult | 'running' | null>(null)
  const cleanUp = window.api.speech.cleanUpDictation
  if (!on || !cleanUp || !text) {
    return null
  }
  const run = async (): Promise<void> => {
    setResult('running')
    setResult(
      await cleanUp(text, captureDictationContext(), createNonSecureContextUuid()).catch(
        (error: unknown): DictationCleanupResult => ({ status: 'failed', reason: String(error) })
      )
    )
  }
  if (result === null || result === 'running') {
    return (
      <Button
        variant="outline"
        size="xs"
        disabled={result === 'running'}
        onClick={() => void run()}
      >
        {result === 'running' ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : null}
        {result === 'running'
          ? t('components.settings.voice.micTest.cleaningUp', 'Cleaning up…')
          : t('components.settings.voice.micTest.tryCleanup', 'Try cleanup')}
      </Button>
    )
  }
  if (result.status !== 'cleaned') {
    return (
      <p className="text-xs text-muted-foreground">
        {result.status === 'failed'
          ? t('components.settings.voice.micTest.cleanupFailed', 'Cleanup failed: {{reason}}', {
              reason: result.reason
            })
          : result.status === 'timed-out'
            ? t('components.settings.voice.micTest.cleanupTimedOut', 'Cleanup took too long.')
            : t('components.settings.voice.micTest.cleanupOff', 'AI cleanup is off.')}
      </p>
    )
  }
  return (
    <div className="space-y-0.5 rounded-md bg-muted/60 px-3 py-2">
      <p className="text-2xs text-muted-foreground">
        {t(
          'components.settings.voice.micTest.afterCleanup',
          'After cleanup · {{agent}}, {{model}} · {{seconds}} s',
          {
            agent: result.agentLabel,
            model: result.model,
            seconds: (result.elapsedMs / 1000).toFixed(1)
          }
        )}
      </p>
      <p className="text-sm">{result.text}</p>
    </div>
  )
}
