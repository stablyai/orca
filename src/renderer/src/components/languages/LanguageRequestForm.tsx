import { useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { track } from '@/diagnostics/telemetry/telemetry'
import { onboardingLanguageMetadata } from '../onboarding/onboarding-language-telemetry'

/** The picker's footer row; flat like the other dialogs' footers. Shared with the request form. */
export const LANGUAGE_PICKER_FOOTER_CLASS =
  '@container flex items-center justify-between gap-2 px-5 pt-3 pb-5'

/** Replaces the picker's list and footer, so the form's own actions are the only action row. */
export function LanguageRequestForm({
  onBack,
  onDone,
  onboarding,
  initialDraft = ''
}: {
  onBack: () => void
  onDone: () => void
  onboarding: boolean
  initialDraft?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(initialDraft)
  const [status, setStatus] = useState<'idle' | 'pending' | 'error' | 'success'>('idle')
  const pending = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const submit = async (): Promise<void> => {
    const request = draft.trim()
    if (!request) {
      // Why: the submit button stays enabled; an empty submit points at the field instead.
      input.current?.focus()
      return
    }
    if (pending.current) {
      return
    }
    pending.current = true
    setStatus('pending')
    try {
      const result = await window.api.feedback.submit({
        feedback: `Language request: ${request}`,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
      setStatus(result.ok ? 'success' : 'error')
      if (result.ok && onboarding) {
        track('onboarding_language_requested', onboardingLanguageMetadata())
      }
    } catch {
      setStatus('error')
    }
    pending.current = false
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-2 px-5 pb-5">
        <Label htmlFor="language-request">
          {t('onboarding.language.requestPrompt', 'Which language would you like Orca to support?')}
        </Label>
        <Input
          ref={input}
          id="language-request"
          autoFocus
          maxLength={80}
          value={draft}
          placeholder={t('languages.requestPlaceholder', 'e.g. Polski, Tiếng Việt')}
          disabled={status === 'pending' || status === 'success'}
          onChange={(event) => {
            setDraft(event.target.value)
            setStatus('idle')
          }}
        />
        {status === 'success' && (
          <p role="status" className="text-xs text-muted-foreground">
            {t('languages.requestRecorded', 'Language request recorded.')}
          </p>
        )}
        {status === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            {t('onboarding.language.requestError', 'Could not record your request. Try again.')}
          </p>
        )}
      </div>
      <div className={LANGUAGE_PICKER_FOOTER_CLASS}>
        <Button type="button" size="sm" variant="ghost" className="-ml-2.5" onClick={onBack}>
          <ArrowLeft />
          {t('onboarding.language.back', 'Languages')}
        </Button>
        {status === 'success' ? (
          <Button type="button" size="sm" variant="outline" onClick={onDone}>
            {t('languages.done', 'Done')}
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={status === 'pending'}>
            {t('onboarding.language.requestAction', 'Request language')}
          </Button>
        )}
      </div>
    </form>
  )
}
