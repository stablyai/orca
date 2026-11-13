import { ChevronDown, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { subagentStateLabel } from '../../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import {
  subagentEntryRunsOn,
  subagentRoleLabel
} from '../../../../../shared/native-chat/transcript/native-chat-subagent-entry-detail'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import { StatusDot } from './NativeChatSubagentRun'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
import { sayNativeChatSessionOptionTranslated as sayOption } from '../session/options/controls/native-chat-session-option-labels-text'

const CHIP_CLASS =
  'min-w-0 shrink truncate rounded-full border border-border px-1.5 font-sans text-3xs text-chat-foreground-faint'

/** Above a subagent's own transcript: back to the main agent, and a switcher over every subagent. */
export function NativeChatSubagentViewBar({
  agentId,
  entries,
  agentsWithRows,
  onOpen
}: {
  agentId: string
  /** Every subagent the session names, in roster order. */
  entries: ReadonlyMap<string, NativeChatSubagentEntry>
  /** Subagents with rows, some of which no roster names. */
  agentsWithRows: ReadonlyMap<string, unknown>
  onOpen: (agentId: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const unnamed = t('components.native-chat.subagents.unnamed', 'Subagent')
  const mainAgent = t('components.native-chat.subagents.mainAgent', 'Main agent')
  const agentIds = [
    ...entries.keys(),
    ...Array.from(agentsWithRows.keys()).filter((id) => !entries.has(id))
  ]
  const entry = entries.get(agentId)
  const state = entry ? normalizeSubagentState(entry.state) : null
  const role = subagentRoleLabel(entry?.agentType)
  const runsOn = entry ? subagentEntryRunsOn(entry, sayOption) : null
  return (
    <div className="shrink-0 border-b border-border/60 bg-chat-pane px-3 sm:px-4">
      <div className="mx-auto flex h-10 w-full text-chat-foreground-strong max-w-(--chat-content-max-width) min-w-0 items-center gap-1 px-[5px]">
        <Button
          type="button"
          variant="muted-field-icon"
          size="xs"
          className="-ml-1.5 shrink-0"
          onClick={() => onOpen(null)}
        >
          <ChevronLeft aria-hidden />
          {mainAgent}
        </Button>
        <span aria-hidden className="shrink-0 text-xs text-chat-foreground-faint">
          /
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="inlineChip" className="min-w-0 shrink">
              {state ? <StatusDot state={state} pulsing={state === 'working'} /> : null}
              <span className="min-w-0 truncate">{entry?.label ?? unnamed}</span>
              <ChevronDown aria-hidden className="text-chat-foreground-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem onSelect={() => onOpen(null)}>
              <span aria-hidden className="size-3 shrink-0" />
              {mainAgent}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {agentIds.map((id) => {
              const listed = entries.get(id)
              const listedState = listed ? normalizeSubagentState(listed.state) : null
              return (
                <DropdownMenuItem
                  key={id}
                  data-current={id === agentId}
                  onSelect={() => onOpen(id)}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center">
                    {listedState ? (
                      <StatusDot state={listedState} pulsing={listedState === 'working'} />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{listed?.label ?? unnamed}</span>
                  {listedState ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {subagentStateLabel(listedState, 1, 1, say)}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {role ? <span className={CHIP_CLASS}>{role}</span> : null}
        {runsOn ? <span className={CHIP_CLASS}>{runsOn}</span> : null}
      </div>
    </div>
  )
}
