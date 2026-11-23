import { Loader2, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslate } from '@/i18n/use-translate'
import type { ConversationKnowledgeIndexStatus } from '../../../../shared/conversation-knowledge-items'
import { ConversationKnowledgeIndexButton } from './ConversationKnowledgeIndexButton'

export function ConversationKnowledgeIndexProgress({
  status,
  disabled,
  onGenerateUpdates,
  onRegenerateAll,
  onStop
}: {
  status: ConversationKnowledgeIndexStatus
  disabled: boolean
  onGenerateUpdates: () => void
  onRegenerateAll: () => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const active = status.activeSession
  const canceled = status.canceled ?? 0
  const settled = status.completed + status.failed + canceled
  const queued = Math.max(0, status.total - settled - (active ? 1 : 0))
  const progress = status.total ? Math.round((settled / status.total) * 100) : 0
  const isRunning = status.state === 'running'

  return (
    <section
      className="rounded-md border border-border bg-muted/20 px-3 py-2 shadow-xs"
      aria-label={t('conversationKnowledge.status.panelLabel', 'Generation progress')}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium">
            {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : null}
            <span>
              {isRunning
                ? t('conversationKnowledge.status.indexing', 'Indexing')
                : status.total
                  ? t('conversationKnowledge.status.indexed', 'Indexed')
                  : t('conversationKnowledge.status.ready', 'Ready to generate')}
            </span>
            {status.total ? (
              <span className="text-muted-foreground">
                {t('conversationKnowledge.status.progressCount', '{{completed}} of {{total}}', {
                  completed: settled,
                  total: status.total
                })}
              </span>
            ) : null}
          </div>
          {isRunning && active ? (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {t('conversationKnowledge.status.currentSession', 'Agent is processing: {{title}}', {
                title: active.title
              })}
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {isRunning
                ? t(
                    'conversationKnowledge.status.waitingForAgent',
                    'Waiting for the next agent task.'
                  )
                : t(
                    'conversationKnowledge.status.readyDescription',
                    'Generate updates to index new or changed conversations.'
                  )}
            </p>
          )}
        </div>
        {isRunning ? (
          <Button size="xs" variant="outline" onClick={onStop}>
            <Square />
            {t('conversationKnowledge.stop', 'Stop generating')}
          </Button>
        ) : (
          <ConversationKnowledgeIndexButton
            running={false}
            disabled={disabled}
            onGenerateUpdates={onGenerateUpdates}
            onRegenerateAll={onRegenerateAll}
            onStop={onStop}
          />
        )}
      </div>
      <Progress className="mt-2 h-1.5" value={progress} />
      <div className="mt-2 flex flex-wrap gap-1.5" aria-live="polite">
        <StatusBadge
          label={t('conversationKnowledge.status.completed', 'Completed')}
          value={status.completed}
        />
        <StatusBadge
          label={t('conversationKnowledge.status.active', 'In progress')}
          value={active ? 1 : 0}
          active={Boolean(active)}
        />
        <StatusBadge label={t('conversationKnowledge.status.queued', 'Queued')} value={queued} />
        <StatusBadge
          label={t('conversationKnowledge.status.failed', 'Failed')}
          value={status.failed}
          destructive={status.failed > 0}
        />
        {canceled ? (
          <StatusBadge
            label={t('conversationKnowledge.status.canceled', 'Stopped')}
            value={canceled}
          />
        ) : null}
      </div>
    </section>
  )
}

function StatusBadge({
  label,
  value,
  active = false,
  destructive = false
}: {
  label: string
  value: number
  active?: boolean
  destructive?: boolean
}): React.JSX.Element {
  return (
    <Badge variant={destructive ? 'destructive' : active ? 'default' : 'secondary'}>
      <span className="tabular-nums">{value}</span>
      <span>{label}</span>
    </Badge>
  )
}
