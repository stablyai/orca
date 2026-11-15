import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { recomputeOn } from '@/lib/recompute-on'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { NativeChatBackgroundTaskBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatBackgroundTaskRun } from '../../../../../../shared/native-chat/transcript/turns/native-chat-background-task-run'
import { sayBackgroundTaskTranslated } from './background-task-words-text'
import { KIND_ICONS } from './NativeChatBackgroundTasksStatus'

export function NativeChatBackgroundTaskRun({
  block
}: {
  block: NativeChatBackgroundTaskBlock
}): React.JSX.Element {
  const t = useTranslate()
  // The sayer reads translate(); key the row on `t` so its words follow the UI language.
  const row = recomputeOn([t], () =>
    nativeChatBackgroundTaskRun(block, sayBackgroundTaskTranslated)
  )
  const Icon = KIND_ICONS[row.kind]
  return (
    <div className="min-w-0 py-0.5 font-sans text-sm leading-relaxed text-chat-foreground-faint">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-chat-foreground-faint" />
        <AgentStateDot state={row.state} size="sm" title={null} />
        <span className="min-w-0 truncate text-chat-foreground" title={row.label}>
          {row.label}
        </span>
        <span className="ml-auto shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
          {row.status}
        </span>
      </div>
      {row.sentence === null ? null : (
        <p className={cn('mt-0.5 pl-7 text-xs', row.state === 'blocked' && 'text-destructive')}>
          {row.sentence}
        </p>
      )}
      {row.output === null ? null : (
        <p className="mt-0.5 truncate pl-7 font-mono text-xs text-chat-foreground-faint">
          {row.output}
        </p>
      )}
    </div>
  )
}
