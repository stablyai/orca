import { humanRecurringAnswer } from '../../../../shared/commander/recurring-answer'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { memoryActor } from './commander-memory-labels'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'
export function Revision({ page }: { page: CommanderMemoryRevision }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const rule = humanRecurringAnswer(page)
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {page.deleted
          ? t('commander.memory.deleted', 'Deleted')
          : t('commander.memory.edited', 'Edited')}{' '}
        · {memoryActor(t, page.actor.type)} · {page.actor.id} ·{' '}
        <time dateTime={page.createdAt}>{new Date(page.createdAt).toLocaleString(locale)}</time>
      </p>
      {rule ? (
        <dl className="space-y-2">
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('commander.rules.question', 'Exact question')}
            </dt>
            <dd className="whitespace-pre-wrap break-words">{rule.question}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('commander.rules.answer', 'Answer')}
            </dt>
            <dd className="whitespace-pre-wrap break-words">{rule.answer}</dd>
          </div>
        </dl>
      ) : (
        <CommentMarkdown variant="document" content={page.body} />
      )}
    </div>
  )
}

function HistoryEntry({ item }: { item: CommanderMemoryRevision }): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer break-words text-xs">
        {t('commander.memory.version', 'v{{version}}', { version: item.version })} ·{' '}
        {item.deleted ? t('commander.memory.deleted', 'Deleted') : item.title} ·{' '}
        {memoryActor(t, item.actor.type)} · {item.actor.id}
      </summary>
      {expanded && <Revision page={item} />}
    </details>
  )
}

export function MemoryHistory({
  history,
  initialCursor,
  account,
  onRefresh
}: {
  history: CommanderMemoryRevision[]
  initialCursor: number | null
  account: CommanderAccount
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const [more, setMore] = useState<{
    items: CommanderMemoryRevision[]
    cursor: number | null
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const cursor = more ? more.cursor : initialCursor
  const page = history[0]
  async function loadMore(): Promise<void> {
    if (!page || cursor === null || pending) {
      return
    }
    setPending(true)
    setError('')
    try {
      const data = await window.api.commanderMemory.get(account, page.pageId, cursor)
      if (data.page.version !== page.version) {
        onRefresh()
      } else {
        setMore({
          items: [...(more?.items ?? []), ...data.history],
          cursor: data.nextBeforeVersion ?? null
        })
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('commander.memory.readError', 'Could not load this page.')
      )
    }
    setPending(false)
  }
  return (
    <details
      className="border-t border-border pt-3"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">
        {t('commander.memory.history', 'Revision history ({{count}})', {
          count: page?.version ?? 0
        })}
      </summary>
      {expanded && (
        <ol className="space-y-2 pt-2">
          {[...history, ...(more?.items ?? [])].map((item) => (
            <li key={item.version}>
              <HistoryEntry item={item} />
            </li>
          ))}
        </ol>
      )}
      {expanded && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {expanded && cursor !== null && (
        <Button size="xs" variant="outline" disabled={pending} onClick={() => void loadMore()}>
          {t('commander.memory.loadOlder', 'Load older revisions')}
        </Button>
      )}
    </details>
  )
}
