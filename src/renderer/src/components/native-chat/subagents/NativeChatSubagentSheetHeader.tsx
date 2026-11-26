import { useMemo } from 'react'
import { ChevronDown, ChevronLeft, X } from 'lucide-react'
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
import { formatSubagentTokens } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import { subagentRoleLabel } from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { SubagentElapsed } from './NativeChatSubagentRun'
import { NativeChatSubagentStatusIcon } from './NativeChatSubagentStatusIcon'
import {
  sayNativeChatSubagentGroupTranslated as say,
  sayNativeChatSubagentStateHeading
} from './native-chat-subagent-group-words-text'
import { nativeChatSubagentSwitcherItems } from './native-chat-subagent-switcher-items'
import {
  NATIVE_CHAT_SUBAGENT_SHEET_CLOSE_ATTRIBUTE,
  type NativeChatSubagentSheetControls
} from './native-chat-open-subagent'

const MAIN = ''

/** Tops a subagent's sheet: its parent, a switcher over every subagent, its state, Stop and Close. */
export function NativeChatSubagentSheetHeader({
  chain,
  entries,
  subagentRows,
  onOpen,
  controls
}: {
  /** The spawn chain down to the open subagent, outermost first. */
  chain: readonly string[]
  /** Every subagent the session names, in roster order. */
  entries: ReadonlyMap<string, NativeChatSubagentEntry>
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  onOpen: (agentId: string | null) => void
  controls: NativeChatSubagentSheetControls
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
  const parentId = chain.at(-2)
  const entry = entries.get(agentId)
  const state = entry ? normalizeSubagentState(entry.state) : null
  const role = subagentRoleLabel(entry?.agentType)
  const { waiting } = controls
  const counting = state === 'working'
  return (
    <div className="shrink-0">
      <div className="flex items-start gap-2 border-b border-border/60 py-2 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <div className="flex h-6 min-w-0 items-center gap-1.5 text-chat-foreground-strong">
            {parentId !== undefined ? (
              <Button
                type="button"
                variant="muted-field-icon"
                size="xs"
                className="-ml-1.5 min-w-0 max-w-40 shrink"
                aria-label={t('components.native-chat.subagents.backTo', 'Back to {{value0}}', {
                  value0: labelOf(parentId)
                })}
                onClick={() => onOpen(parentId)}
              >
                <ChevronLeft aria-hidden />
                <span className="truncate">{labelOf(parentId)}</span>
              </Button>
            ) : null}
            {state ? <NativeChatSubagentStatusIcon state={state} /> : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="inlineChip"
                  className="-ml-1 min-w-0 shrink"
                >
                  <span id={controls.titleId} className="min-w-0 truncate font-semibold">
                    {labelOf(agentId)}
                  </span>
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
                          {listedState ? (
                            <NativeChatSubagentStatusIcon state={listedState} />
                          ) : null}
                        </span>
                        {/* Wraps rather than ellipsizing, so a label's own period never runs into one. */}
                        <span className="line-clamp-2 min-w-0 flex-1 break-words">
                          {item.label}
                        </span>
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
            {role ? (
              <span className="min-w-0 shrink truncate rounded-full border border-border px-1.5 font-sans text-3xs text-chat-foreground-faint @max-[421px]/subagent-sheet:hidden">
                {role}
              </span>
            ) : null}
            {waiting === agentId ? (
              <span className="shrink-0 rounded-full bg-status-warning px-1.5 text-3xs leading-4 font-medium whitespace-nowrap text-black">
                {t('components.native-chat.subagents.needsYou', 'Needs you')}
              </span>
            ) : null}
          </div>
          {/* Keeps its height without a known state, so the header never shrinks between subagents. */}
          <div
            aria-live="polite"
            className="h-4 min-w-0 truncate pl-[18px] text-xs text-chat-foreground-faint tabular-nums"
          >
            {state ? sayNativeChatSubagentStateHeading(state) : null}
            {entry?.startedAt !== undefined ? (
              // Ticking digits stay out of live announcements.
              <span
                aria-hidden={counting || undefined}
                className="@max-[20rem]/subagent-sheet:hidden"
              >
                {' · '}
                <SubagentElapsed
                  startedAt={entry.startedAt}
                  settledAt={entry.settledAt ?? null}
                  counting={counting}
                />
              </span>
            ) : null}
            {typeof entry?.tokens === 'number' ? (
              <span
                aria-hidden={counting || undefined}
                className="@max-[24rem]/subagent-sheet:hidden"
              >
                {` · ${say('tokens', { value0: formatSubagentTokens(entry.tokens) })}`}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex h-6 shrink-0 items-center gap-1">
          {controls.stop}
          <Button
            {...{ [NATIVE_CHAT_SUBAGENT_SHEET_CLOSE_ATTRIBUTE]: '' }}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('components.native-chat.subagents.close', 'Close')}
            onClick={() => onOpen(null)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Pinned atop a sheet's rows while another agent's prompt waits: who, and the way to it. */
export function NativeChatSubagentNeedsYouLine({
  label,
  onShow
}: {
  /** The waiting subagent's name; null for the main agent. */
  label: string | null
  onShow: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    // The sheet's body pads 12px above; the line pins over it and paints it, like the rows' backdrop.
    <div className="sticky -top-3 z-10 -mt-3 bg-chat-sheet pt-3 pb-1">
      <div
        role="status"
        className="flex items-center gap-2 rounded-[10px] border border-status-warning py-1.5 pr-1.5 pl-3 text-xs text-chat-foreground-strong"
      >
        <span className="min-w-0 flex-1 truncate">
          {label === null
            ? t('components.native-chat.subagents.mainNeedsYou', 'Main agent needs you')
            : t('components.native-chat.subagents.agentNeedsYou', '{{name}} needs you', {
                name: label
              })}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={onShow}>
          {t('components.native-chat.subagents.show', 'Show')}
        </Button>
      </div>
    </div>
  )
}
