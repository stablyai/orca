import { Fragment, useMemo } from 'react'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import {
  subagentEntryRunsOn,
  subagentRoleLabel
} from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { NativeChatSubagentStatusIcon } from './NativeChatSubagentStatusIcon'
import { sayNativeChatSubagentStateHeading } from './native-chat-subagent-group-words-text'
import { sayNativeChatSessionOptionTranslated as sayOption } from '../session/options/controls/native-chat-session-option-labels-text'
import { nativeChatSubagentSwitcherItems } from './native-chat-subagent-switcher-items'

const CHIP_CLASS =
  'min-w-0 shrink truncate rounded-full border border-border px-1.5 font-sans text-3xs text-chat-foreground-faint'
const MAIN = ''

/** Above a subagent's own transcript: its spawn chain back to the main agent, and a switcher over every subagent. */
export function NativeChatSubagentViewBar({
  chain,
  entries,
  subagentRows,
  onOpen
}: {
  /** The spawn chain down to the open subagent, outermost first. */
  chain: readonly string[]
  /** Every subagent the session names, in roster order. */
  entries: ReadonlyMap<string, NativeChatSubagentEntry>
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  onOpen: (agentId: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const unnamed = t('components.native-chat.subagents.unnamed', 'Subagent')
  const mainAgent = t('components.native-chat.subagents.mainAgent', 'Main agent')
  const items = useMemo(
    () => nativeChatSubagentSwitcherItems(entries, subagentRows, unnamed),
    [entries, subagentRows, unnamed]
  )
  const labelOf = (id: string): string => items.find((item) => item.id === id)?.label ?? unnamed
  const agentId = chain.at(-1)!
  const entry = entries.get(agentId)
  const state = entry ? normalizeSubagentState(entry.state) : null
  const role = subagentRoleLabel(entry?.agentType)
  const runsOn = entry ? subagentEntryRunsOn(entry, sayOption) : null
  return (
    <div className="shrink-0 border-b border-border/60 bg-chat-pane px-3 sm:px-4">
      <nav
        aria-label={t('components.native-chat.subagents.path', 'Subagent path')}
        className="mx-auto flex h-10 w-full max-w-(--chat-content-max-width) min-w-0 items-center gap-1 px-[5px] text-chat-foreground-strong"
      >
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
        {chain.slice(0, -1).map((ancestor) => (
          <Fragment key={ancestor}>
            <span aria-hidden className="shrink-0 text-xs text-chat-foreground-faint">
              /
            </span>
            <Button
              type="button"
              variant="muted-field-icon"
              size="xs"
              className="min-w-0 max-w-40 shrink"
              onClick={() => onOpen(ancestor)}
            >
              <span className="truncate">{labelOf(ancestor)}</span>
            </Button>
          </Fragment>
        ))}
        <span aria-hidden className="shrink-0 text-xs text-chat-foreground-faint">
          /
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="inlineChip"
              aria-current="page"
              className="min-w-0 shrink"
            >
              {state ? <NativeChatSubagentStatusIcon state={state} /> : null}
              <span className="min-w-0 truncate">{labelOf(agentId)}</span>
              <ChevronDown aria-hidden className="text-chat-foreground-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuRadioGroup
              value={agentId}
              onValueChange={(value) => onOpen(value === MAIN ? null : value)}
            >
              <DropdownMenuRadioItem value={MAIN}>{mainAgent}</DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {items.map((item) => {
                const listed = entries.get(item.id)
                const listedState = listed ? normalizeSubagentState(listed.state) : null
                return (
                  <DropdownMenuRadioItem
                    key={item.id}
                    value={item.id}
                    aria-current={item.id === agentId ? 'true' : undefined}
                    // Children sit under the subagent that spawned them.
                    style={{ paddingInlineStart: `${2 + item.depth * 0.875}rem` }}
                  >
                    <span className="flex size-3 shrink-0 items-center justify-center">
                      {listedState ? <NativeChatSubagentStatusIcon state={listedState} /> : null}
                    </span>
                    {/* Wraps rather than ellipsizing, so a label's own period never runs into one. */}
                    <span className="line-clamp-2 min-w-0 flex-1 break-words">{item.label}</span>
                    {listedState ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {sayNativeChatSubagentStateHeading(listedState)}
                      </span>
                    ) : null}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {role ? <span className={CHIP_CLASS}>{role}</span> : null}
        {runsOn ? <span className={CHIP_CLASS}>{runsOn}</span> : null}
      </nav>
    </div>
  )
}
