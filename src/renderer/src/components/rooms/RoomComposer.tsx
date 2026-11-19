import { Loader2, SendHorizonal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
/** Multi-line composer with @-mention completion and quiet delivery status. */
export function RoomComposer(props: {
  composer: string
  sending: boolean
  directMemberName: string | null
  mentionOptions: string[]
  mentionQuery: string | null
  onComposerChange: (value: string) => void
  onApplyMention: (name: string) => void
  onSend: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { mentionOptions, mentionQuery } = props
  return (
    <footer className="shrink-0 p-3">
      <div className="mx-auto max-w-4xl">
        {mentionOptions.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {mentionOptions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => props.onApplyMention(name)}
                className="rounded-full border border-border/60 bg-accent/50 px-2 py-0.5 text-xs hover:bg-accent"
              >
                @{name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="rounded-2xl border border-border/60 bg-card p-2">
          <div className="flex items-end gap-2">
            <Textarea
              rows={1}
              className="max-h-40 min-h-10"
              placeholder={
                props.directMemberName
                  ? translate('auto.components.rooms.page.directPlaceholder', 'Message {{name}}…', {
                      name: props.directMemberName
                    })
                  : translate('auto.components.rooms.page.composerPlaceholder', 'Message the team…')
              }
              value={props.composer}
              onChange={(e) => props.onComposerChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  if (
                    mentionOptions.length > 0 &&
                    mentionQuery !== null &&
                    mentionQuery.length > 0
                  ) {
                    e.preventDefault()
                    props.onApplyMention(mentionOptions[0])
                    return
                  }
                  e.preventDefault()
                  props.onSend()
                }
                if (e.key === 'Tab' && mentionOptions.length > 0) {
                  e.preventDefault()
                  props.onApplyMention(mentionOptions[0])
                }
                if (e.key === 'Escape' && mentionOptions.length > 0) {
                  props.onComposerChange(props.composer.replace(/@([\w\u4e00-\u9fa5]*)$/, ''))
                }
              }}
              disabled={props.sending}
            />
            <Button
              size="icon"
              className="size-9 shrink-0"
              aria-label={translate('auto.components.rooms.page.send', 'Send')}
              onClick={props.onSend}
              disabled={props.sending || !props.composer.trim()}
            >
              {props.sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SendHorizonal className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </footer>
  )
}
