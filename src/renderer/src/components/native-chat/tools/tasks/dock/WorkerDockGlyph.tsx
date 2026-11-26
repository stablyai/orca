import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { cn } from '@/lib/class-names'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { KIND_ICONS } from '../background-task-kind-icons'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

export function WorkerDockGlyph({
  glyph,
  kind,
  still = false
}: {
  glyph: Glyph
  kind?: WorkerDockEntry['kind']
  still?: boolean
}) {
  const KindIcon = kind && KIND_ICONS[kind === 'worker' ? 'agent' : kind]
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1">
      {KindIcon ? <KindIcon className="size-3.5 text-muted-foreground" /> : null}
      <span
        data-worker-dock-glyph={glyph}
        className="inline-flex size-3 shrink-0 items-center justify-center"
      >
        {glyph === 'ask' ? (
          <AgentQuestionIcon className="size-3" />
        ) : glyph === 'running' && still ? (
          <span className="block size-1.5 rounded-full bg-agent-working" />
        ) : glyph === 'running' ? (
          <AgentWorkingSpinner className="size-2.5" />
        ) : (
          <span
            className={cn(
              'block size-2 rounded-full',
              glyph === 'failed' && 'bg-destructive',
              glyph === 'done' && 'bg-status-success',
              glyph === 'queued' && 'border-[1.5px] border-muted-foreground'
            )}
          />
        )}
      </span>
    </span>
  )
}
