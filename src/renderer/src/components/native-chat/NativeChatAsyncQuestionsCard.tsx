import { MessageCircleQuestion, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { nativeChatAsyncQuestionKeyedOptions } from '../../../../shared/native-chat-async-question-answers'
import type { NativeChatAsyncQuestionsCardModel } from './use-native-chat-async-questions'

/**
 * Codex's non-blocking questions above the composer, which stays usable: each
 * question's suggested choices and a free-text answer, a per-question Dismiss
 * (this device only), and one Send that posts the answers as an ordinary message.
 */
export function NativeChatAsyncQuestionsCard({
  model
}: {
  model: NativeChatAsyncQuestionsCardModel
}): React.JSX.Element | null {
  const { open, omittedCount, edits, held, sending, canSend } = model
  if (open.length === 0) {
    return null
  }
  return (
    <div className="shrink-0 bg-background" aria-busy={sending}>
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 sm:px-4">
        <div
          data-native-chat-async-questions-card="true"
          className="flex max-h-[40vh] flex-col overflow-hidden rounded-lg border border-input bg-card shadow-xs"
        >
          <div className="min-h-0 divide-y divide-border/60 overflow-y-auto scrollbar-sleek">
            {open.map((question) => {
              const answer = edits[question.key]
              // A held question shows the answer on its way; Dismiss stays usable.
              const locked = sending || held.has(question.key)
              return (
                <div key={question.key} className="flex flex-col gap-2 px-3.5 py-2.5">
                  <div className="flex items-start gap-2">
                    <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">
                      {question.title}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={sending}
                      onClick={() => model.dismiss(question.key)}
                      aria-label={translate(
                        'components.native-chat.asyncQuestions.dismiss',
                        'Dismiss'
                      )}
                    >
                      <X />
                    </Button>
                  </div>
                  {question.options && question.options.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {nativeChatAsyncQuestionKeyedOptions(question.options).map(
                        ({ key, option }) => (
                          <Button
                            key={key}
                            variant={answer?.option === option ? 'secondary' : 'outline'}
                            size="xs"
                            disabled={locked}
                            aria-pressed={answer?.option === option}
                            onClick={() =>
                              model.edit(question.key, {
                                ...answer,
                                option: answer?.option === option ? undefined : option
                              })
                            }
                          >
                            {option}
                          </Button>
                        )
                      )}
                    </div>
                  ) : null}
                  <Input
                    value={answer?.text ?? ''}
                    disabled={locked}
                    onChange={(event) =>
                      model.edit(question.key, { ...answer, text: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        model.submit()
                      }
                    }}
                    placeholder={translate(
                      'components.native-chat.question.otherPlaceholder',
                      'Type your answer'
                    )}
                  />
                </div>
              )
            })}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3.5 py-2">
            {omittedCount > 0 ? (
              <p className="mr-auto text-xs text-muted-foreground">
                {translate(
                  'components.native-chat.asyncQuestions.more',
                  '{{count}} more questions in the transcript',
                  { count: omittedCount }
                )}
              </p>
            ) : null}
            <Button size="xs" disabled={!canSend} onClick={model.submit}>
              {sending
                ? translate('components.native-chat.question.sending', 'Sending…')
                : translate('components.native-chat.question.send', 'Submit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
