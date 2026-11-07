import { useId, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { Textarea } from '@/components/ui/textarea'

export function SessionLinkOwnerDecision({
  question,
  disabled,
  atomic,
  embedded = false,
  onAnswer
}: {
  question: string
  disabled: boolean
  atomic: boolean
  embedded?: boolean
  onAnswer: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [answer, setAnswer] = useState('')
  const answerId = useId()
  return (
    <section
      className={embedded ? 'space-y-3' : 'space-y-3 rounded-md border p-3'}
      aria-label={t('components.sessionLink.ownerQuestion', 'Question for you')}
    >
      {!embedded ? (
        <p className="text-sm font-medium">
          {t('components.sessionLink.ownerQuestion', 'Question for you')}
        </p>
      ) : null}
      <div className="max-h-48 overflow-y-auto text-sm scrollbar-sleek">
        <NativeChatQuestionText content={question} />
      </div>
      <Label htmlFor={answerId}>
        {t('components.sessionLink.ownerAnswer', 'Your decision for both agents')}
      </Label>
      <Textarea
        id={answerId}
        value={answer}
        maxLength={8192}
        disabled={disabled}
        onChange={(e) => setAnswer(e.target.value)}
      />
      {!atomic ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.sessionLink.legacyAnswer',
            'This host needs two steps: send your answer, then continue the link. Update the desktop app for one-step continuation.'
          )}
        </p>
      ) : null}
      <Button
        disabled={disabled || !answer.trim()}
        onClick={() =>
          void onAnswer(answer).then((ok) => {
            if (ok) {
              setAnswer('')
            }
          })
        }
      >
        {atomic
          ? t('components.sessionLink.answerResume', 'Answer and continue')
          : t('components.sessionLink.sendBoth', 'Send to both')}
      </Button>
    </section>
  )
}
