import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Laptop, Smartphone } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { BrowserFavicon } from '@/components/browser-favicon'
import { useTabAgent } from '@/lib/agent-session/tab-identity/use-tab-agent'
import { useStructuredChatTabConversationName } from '@/runtime/native-chat/naming/structured-conversation-name'
import { getShortcutPlatform } from '../../hooks/useShortcutLabel'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  parseKeybinding
} from '../../../../shared/keybindings'
import { captureFocusBeforeRestore, restoreTabStripFocus } from './tab-strip-focus-restore'
import { agentTypeToIconAgent } from '../../../../shared/agent-status/presentation/agent-type-icon-agent'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { ShellIcon } from './shell-icons'
import { getTabDragLabel, type TabBarItem } from './tab-bar-item-model'
import { getClientHostedBrowserRowLabel } from './client-hosted-browser-row-label'

export type TabStripEntry =
  | { id: string; kind: 'item'; item: TabBarItem }
  | { id: string; kind: 'paired'; row: ClientHostedBrowserRow }

const MAX_SHORTCUT_ROWS = 9

function TerminalEntryIcon({ tab }: { tab: TerminalTab }): React.JSX.Element {
  const agent = useTabAgent(tab)
  return agent ? (
    <AgentIcon agent={agent} size={12} />
  ) : (
    <ShellIcon shell={tab.shellOverride} size={12} />
  )
}

function EntryIcon({ entry }: { entry: TabStripEntry }): React.JSX.Element {
  if (entry.kind === 'paired') {
    return <Laptop className="size-3 shrink-0 text-callout-note" aria-hidden />
  }
  const { item } = entry
  switch (item.type) {
    case 'terminal':
      return <TerminalEntryIcon tab={item.data} />
    case 'agent-session':
      return <AgentIcon agent={agentTypeToIconAgent(item.data.agentSessionAgent)} size={12} />
    case 'browser':
      return (
        <BrowserFavicon
          faviconUrl={item.data.faviconUrl}
          className="size-3"
          fallbackClassName="text-callout-note"
        />
      )
    case 'simulator':
      return <Smartphone className="size-3 shrink-0" aria-hidden />
    case 'editor':
      return <FileTypeIcon filePath={item.data.filePath} className="size-3 shrink-0" />
  }
}

function useEntryLabel(entry: TabStripEntry, generatedTabTitlesEnabled: boolean): string {
  const t = useTranslate()
  const conversationName = useStructuredChatTabConversationName(
    entry.kind === 'item' && entry.item.type === 'agent-session' ? entry.item.data : undefined
  )
  return entry.kind === 'paired'
    ? getClientHostedBrowserRowLabel(entry.row, t)
    : getTabDragLabel(entry.item, generatedTabTitlesEnabled, conversationName, t)
}

function EntryRow({
  entry,
  isCurrent,
  needsAttention,
  shortcut,
  generatedTabTitlesEnabled,
  onSelect
}: {
  entry: TabStripEntry
  isCurrent: boolean
  needsAttention: boolean
  shortcut: string | null
  generatedTabTitlesEnabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = useEntryLabel(entry, generatedTabTitlesEnabled)
  return (
    <DropdownMenuItem
      data-tab-strip-list-entry={entry.id}
      aria-current={isCurrent ? 'true' : undefined}
      aria-label={
        needsAttention
          ? t('tabStrip.overflow.entryNeedsAttention', '{{title}}, needs attention', {
              title: label
            })
          : label
      }
      onSelect={onSelect}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <EntryIcon entry={entry} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', isCurrent && 'font-medium')}>{label}</span>
      {needsAttention ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-warning" />
      ) : null}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/** tab.selectByIndex bindings are stored canonically on digit 1 and match any digit 1–9. */
function useTabIndexBindings(): readonly string[] {
  const keybindings = useAppStateValue((state) => state.keybindings)
  return useMemo(
    () =>
      getEffectiveKeybindingsForAction(
        'tab.selectByIndex',
        getShortcutPlatform(),
        keybindings
      ).filter((binding) => parseKeybinding(binding)?.key === '1' && /(^|\+)1$/.test(binding)),
    [keybindings]
  )
}

/** Each row's own chord: substitute its digit into every effective binding, then format. Unset → none. */
function shortcutForIndex(bindings: readonly string[], index: number): string | null {
  if (index >= MAX_SHORTCUT_ROWS || bindings.length === 0) {
    return null
  }
  return formatKeybindingList(
    bindings.map((binding) => binding.replace(/1$/, String(index + 1))),
    getShortcutPlatform()
  )
}

/** "+N" (or, when nothing else fits, the active icon and tab count): opens every tab in strip order. */
export function TabStripOverflowChip({
  entries,
  hiddenIds,
  chipOnly,
  activeId,
  attentionIds,
  generatedTabTitlesEnabled,
  isGroupFocused,
  surface,
  onSelect
}: {
  entries: readonly TabStripEntry[]
  hiddenIds: ReadonlySet<string>
  chipOnly: boolean
  activeId: string | null
  attentionIds: ReadonlySet<string>
  generatedTabTitlesEnabled: boolean
  isGroupFocused: boolean
  surface: HTMLElement | null
  onSelect: (entry: TabStripEntry) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const pendingFocusIdRef = useRef<string | null>(null)
  const indexBindings = useTabIndexBindings()
  // tab.selectByIndex counts unified tabs in strip order; paired rows have no digit.
  const unifiedIndexById = useMemo(
    () =>
      new Map(
        entries.filter((entry) => entry.kind === 'item').map((entry, index) => [entry.id, index])
      ),
    [entries]
  )
  const activeEntry = entries.find((entry) => entry.id === activeId) ?? entries[0]
  const activeLabel = useEntryLabel(activeEntry!, generatedTabTitlesEnabled)
  const hiddenAttention = entries.filter(
    (entry) => hiddenIds.has(entry.id) && attentionIds.has(entry.id)
  )
  const firstHiddenAttentionId = hiddenAttention[0]?.id ?? null
  // Why: the strip stays mounted when focus or the workspace moves away; close so it can't act on a stale group.
  if (!isGroupFocused && open) {
    setOpen(false)
  }

  const openRef = useRef(open)
  const surfaceRef = useRef(surface)
  const activeIdRef = useRef(activeId)
  const groupFocusedRef = useRef(isGroupFocused)
  useLayoutEffect(() => {
    openRef.current = open
    surfaceRef.current = surface
    activeIdRef.current = activeId
    groupFocusedRef.current = isGroupFocused
  })
  useEffect(
    () => () => {
      // A resize removed the chip while its list was open: keep focus in the strip.
      if (openRef.current && groupFocusedRef.current) {
        const strip = surfaceRef.current
        const focusBefore = captureFocusBeforeRestore()
        requestAnimationFrame(() =>
          restoreTabStripFocus({
            strip,
            slotId: activeIdRef.current,
            stillOwned: () => groupFocusedRef.current,
            focusBefore
          })
        )
      }
    },
    []
  )

  const count = chipOnly ? entries.length : hiddenIds.size
  const countLabel = count > 99 ? '99+' : String(count)
  const attentionSuffix =
    hiddenAttention.length > 0
      ? t('tabStrip.overflow.needAttention', ', {{count}} need attention', {
          count: hiddenAttention.length,
          defaultValue_one: ', {{count}} needs attention'
        })
      : ''
  const name =
    (chipOnly
      ? t('tabStrip.overflow.chipOnlyName', '{{title}}, {{count}} tabs', {
          title: activeLabel,
          count: entries.length,
          defaultValue_one: '{{title}}, {{count}} tab'
        })
      : t('tabStrip.overflow.moreTabs', '{{count}} more tabs', {
          count: hiddenIds.size,
          defaultValue_one: '{{count}} more tab'
        })) + attentionSuffix

  return (
    <Tooltip>
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-tab-strip-overflow-chip=""
              aria-label={name}
              className="relative mx-0.5 my-auto flex h-6 w-[34px] shrink-0 items-center justify-center gap-0.5 rounded-md text-xs tabular-nums text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-accent/60 data-[state=open]:text-foreground"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {chipOnly && activeEntry ? (
                <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
                  <EntryIcon entry={activeEntry} />
                </span>
              ) : null}
              <span className="overflow-hidden" aria-hidden>
                {chipOnly ? countLabel : `+${countLabel}`}
              </span>
              {hiddenAttention.length > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-status-warning"
                />
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <DropdownMenuContent
          ref={contentRef}
          align="end"
          sideOffset={4}
          className="w-64 max-w-[calc(100vw-1rem)]"
          onOpenAutoFocus={(event) => {
            if (firstHiddenAttentionId === null) {
              return
            }
            // An amber chip opens on the tab that needs the user, so Enter takes them there.
            event.preventDefault()
            const row = contentRef.current?.querySelector<HTMLElement>(
              `[data-tab-strip-list-entry="${CSS.escape(firstHiddenAttentionId)}"]`
            )
            row?.focus()
            row?.scrollIntoView({ block: 'nearest' })
          }}
          onCloseAutoFocus={(event) => {
            const pickedId = pendingFocusIdRef.current
            pendingFocusIdRef.current = null
            // Closed because the group lost focus: leave focus where the user put it.
            if (!isGroupFocused) {
              event.preventDefault()
              return
            }
            if (pickedId === null) {
              return
            }
            event.preventDefault()
            const focusBefore = captureFocusBeforeRestore()
            // Wait for the re-plan that brings the picked tab into view.
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                restoreTabStripFocus({
                  strip: surfaceRef.current,
                  slotId: pickedId,
                  stillOwned: () => groupFocusedRef.current,
                  focusBefore
                })
              )
            )
          }}
        >
          <DropdownMenuLabel>
            {t('tabStrip.overflow.openTabs', '{{count}} open tabs', {
              count: entries.length,
              defaultValue_one: '{{count}} open tab'
            })}
          </DropdownMenuLabel>
          {entries.map((entry) => {
            const index = unifiedIndexById.get(entry.id) ?? MAX_SHORTCUT_ROWS
            return (
              <EntryRow
                key={entry.id}
                entry={entry}
                isCurrent={entry.id === activeId}
                needsAttention={attentionIds.has(entry.id)}
                shortcut={isGroupFocused ? shortcutForIndex(indexBindings, index) : null}
                generatedTabTitlesEnabled={generatedTabTitlesEnabled}
                onSelect={() => {
                  pendingFocusIdRef.current = entry.id
                  onSelect(entry)
                }}
              />
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom" sideOffset={6}>
        {name}
      </TooltipContent>
    </Tooltip>
  )
}
