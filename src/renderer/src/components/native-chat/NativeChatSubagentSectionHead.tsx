import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { normalizeSubagentState } from '../../../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../../../shared/native-chat-types'
import { StatusDot } from './NativeChatSubagentRun'

/** Names the subagent whose rows follow, and opens or closes them, where no loaded
 *  roster row holds its entry: its roster is off the page, or another subagent spawned
 *  it. An agent no roster names has no label or state to show, only that it is one. */
export function NativeChatSubagentSectionHead({
  agentId,
  entry,
  expanded,
  onSetOpen
}: {
  agentId: string
  entry: NativeChatSubagentEntry | undefined
  expanded: boolean
  onSetOpen: (agentId: string, open: boolean) => void
}): React.JSX.Element {
  const state = entry === undefined ? null : normalizeSubagentState(entry.state)
  return (
    <button
      type="button"
      onClick={() => onSetOpen(agentId, !expanded)}
      aria-expanded={expanded}
      className="group/subagent-section flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-muted-foreground hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <ChevronRight
        aria-hidden
        className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
      />
      <Bot aria-hidden className="size-3.5 shrink-0" />
      {state === null ? null : <StatusDot state={state} pulsing={state === 'working'} />}
      <code className="min-w-0 truncate font-mono text-[11px] text-foreground/80">
        {entry?.label ?? translate('components.native-chat.subagents.unnamed', 'Subagent')}
      </code>
    </button>
  )
}
