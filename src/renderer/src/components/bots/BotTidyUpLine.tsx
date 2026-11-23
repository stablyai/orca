// The quiet Home Chat line a tidy-up that changed something leaves; its change count opens the review.
import { useCardBot } from '@/lib/bot-catalog'
import { useState } from 'react'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import { BotTidyUpReview } from '@/components/bots/BotTidyUpReview'
import { useBotTidyUp } from '@/components/bots/use-bot-tidy-up'
import { useTranslate } from '@/i18n/use-translate'
import type { BotTidyUpNote } from '../../../../shared/bots/bot-tidy-up'

/** Read only once Review is open, so a transcript of old lines asks the host nothing. */
function Review({
  botId,
  onClose
}: {
  botId: string
  onClose: () => void
}): React.JSX.Element | null {
  const { view, undo } = useBotTidyUp(useCardBot(botId).ref)
  return view?.last ? (
    <BotTidyUpReview
      run={view.last}
      open
      onOpenChange={(open) => !open && onClose()}
      onUndo={() => view.last?.rowId && void undo(view.last.rowId)}
      onOpenHistory={() => {
        onClose()
        openBotSettings(botId, 'memory-history')
      }}
    />
  ) : null
}

export function BotTidyUpLine({ note }: { note: BotTidyUpNote }): React.JSX.Element {
  const t = useTranslate()
  const [reviewing, setReviewing] = useState(false)
  const changes = t('components.native-chat.tidyUp.changes', '{{count}} changes', {
    count: note.changes,
    defaultValue_one: '{{count}} change'
  })
  return (
    <p className="min-w-0 max-w-full text-sm text-chat-foreground-faint">
      {t('components.native-chat.tidyUp.tidiedMemory', 'Tidied memory')}
      {' · '}
      {note.changes > 0 ? (
        <button
          type="button"
          aria-label={t('components.native-chat.tidyUp.reviewChanges', 'Review {{count}} changes', {
            count: note.changes,
            defaultValue_one: 'Review {{count}} change'
          })}
          className="-mx-0.5 rounded-sm px-0.5 underline underline-offset-2 hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setReviewing(true)}
        >
          {changes}
        </button>
      ) : (
        changes
      )}
      {reviewing ? <Review botId={note.botId} onClose={() => setReviewing(false)} /> : null}
    </p>
  )
}
