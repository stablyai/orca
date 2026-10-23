import { useRef, useState } from 'react'
import {
  Loader2,
  MoreHorizontal,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { ImeInput } from '@/lib/ime-text-field'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** Section-header actions: sync, add, and the rare restore behind ⋯. */
export function SshHostsHeaderActions({
  syncing,
  onSync,
  onAdd,
  onRestoreRemoved
}: {
  syncing: boolean
  onSync: () => void
  onAdd: () => void
  onRestoreRemoved: () => void
}): React.JSX.Element {
  // null while the menu's count is loading; the menu reads ~/.ssh/config only when opened.
  const [removedCount, setRemovedCount] = useState<number | null>(null)
  // Why: a quick close-and-reopen must not let the older read land over the newer one.
  const requestRef = useRef(0)
  const loadRemovedCount = (): void => {
    const request = ++requestRef.current
    setRemovedCount(null)
    const apply = (count: number): void => {
      if (request === requestRef.current) {
        setRemovedCount(count)
      }
    }
    window.api.ssh
      .listConfigHosts({ refresh: true })
      .then((result) => apply(result.hosts.filter((h) => h.previouslyRemoved).length))
      // Why: an unreadable config shouldn't block restore; the dialog explains what it finds.
      .catch(() => apply(-1))
  }
  // An ellipsis promises a dialog, so only the enabled item carries one.
  const restoreLabel =
    removedCount === null
      ? translate(
          'auto.components.settings.SshPaneToolbar.restoreRemovedLoading',
          'Restore removed hosts'
        )
      : removedCount === 0
        ? translate(
            'auto.components.settings.SshPaneToolbar.restoreRemovedNone',
            'No removed hosts to restore'
          )
        : removedCount < 0
          ? translate(
              'auto.components.settings.SshPaneToolbar.restoreRemoved',
              'Restore removed hosts…'
            )
          : translate(
              'auto.components.settings.SshPaneToolbar.restoreRemovedCount',
              'Restore removed hosts ({{count}})…',
              { count: removedCount }
            )

  return (
    <>
      <Button variant="outline" size="sm" onClick={onSync} disabled={syncing}>
        {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {translate('auto.components.settings.SshPaneToolbar.sync', 'Sync ~/.ssh/config')}
      </Button>
      <Button variant="outline" size="sm" onClick={onAdd}>
        <Plus />
        {translate('auto.components.settings.SshPane.addHost', 'Add host')}
      </Button>
      <DropdownMenu modal={false} onOpenChange={(open) => open && loadRemovedCount()}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.settings.SshPaneToolbar.more',
              'More SSH host actions'
            )}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={onRestoreRemoved}
            disabled={syncing || removedCount === null || removedCount === 0}
          >
            <RotateCcw />
            {restoreLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

type SshHostsListToolbarProps = {
  totalCount: number
  visibleCount: number
  selectedCount: number
  allVisibleSelected: boolean
  showFilter: boolean
  filter: string
  busy: boolean
  testing: boolean
  /** Selected hosts a filter change hid and deselected. */
  hiddenDeselectedCount: number
  onFilterChange: (value: string) => void
  onSelectVisible: () => void
  onClearSelection: () => void
  onTestSelected: () => void
  onRemoveSelected: () => void
}

/**
 * The row above the list. The filter stays put while selecting, so "filter, select all, remove"
 * works; only the right side swaps to bulk actions, whose controls keep fixed slots.
 */
export function SshHostsListToolbar(props: SshHostsListToolbarProps): React.JSX.Element {
  const filtering = props.filter.trim() !== ''
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="min-w-48 flex-1">
        {props.showFilter ? (
          <SshHostFilterField value={props.filter} onChange={props.onFilterChange} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.settings.SshPaneToolbar.hostCount', '{{count}} hosts', {
              count: props.totalCount
            })}
          </span>
        )}
      </div>
      {props.selectedCount > 0 ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="mr-1 text-xs font-medium tabular-nums" aria-live="polite">
            {translate('auto.components.settings.SshPaneToolbar.selected', '{{count}} selected', {
              count: props.selectedCount
            })}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={props.onSelectVisible}
            disabled={props.allVisibleSelected}
          >
            {filtering
              ? translate(
                  'auto.components.settings.SshPaneToolbar.selectMatching',
                  'Select all {{count}} matching',
                  { count: props.visibleCount }
                )
              : translate(
                  'auto.components.settings.SshPaneToolbar.selectAll',
                  'Select all {{count}}',
                  { count: props.totalCount }
                )}
          </Button>
          <Button variant="ghost" size="xs" onClick={props.onClearSelection}>
            {translate('auto.components.settings.SshPaneToolbar.clear', 'Clear')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-1"
            onClick={props.onTestSelected}
            disabled={props.busy || props.testing}
          >
            {props.testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {translate('auto.components.settings.SshPaneToolbar.testSelected', 'Test')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={props.onRemoveSelected}
            disabled={props.busy}
          >
            <Trash2 />
            <span className="tabular-nums">
              {translate(
                'auto.components.settings.SshPaneToolbar.removeSelected',
                'Remove {{count}}',
                { count: props.selectedCount }
              )}
            </span>
          </Button>
        </div>
      ) : props.hiddenDeselectedCount > 0 ? (
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {props.hiddenDeselectedCount === 1
            ? translate(
                'auto.components.settings.SshPaneToolbar.hiddenDeselectedSingular',
                '{{count}} hidden host deselected',
                { count: 1 }
              )
            : translate(
                'auto.components.settings.SshPaneToolbar.hiddenDeselectedPlural',
                '{{count}} hidden hosts deselected',
                { count: props.hiddenDeselectedCount }
              )}
        </span>
      ) : null}
    </div>
  )
}

function SshHostFilterField({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const label = translate('auto.components.settings.SshPaneToolbar.filter', 'Filter hosts')
  // Why not <Input>: the icon and clear button live inside the field, which the primitive's
  // fixed padding can't host; this mirrors its border, fill and focus ring on the wrapper.
  return (
    <div className="flex h-8 max-w-64 items-center gap-2 rounded-md border border-input px-2.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <ImeInput
        ref={inputRef}
        value={value}
        aria-label={label}
        placeholder={label}
        className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value !== '' && !event.nativeEvent.isComposing) {
            // Why: the first Escape clears the text, not the selection or Settings.
            event.preventDefault()
            event.stopPropagation()
            onChange('')
          }
        }}
      />
      {value !== '' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-mr-1.5"
          aria-label={translate(
            'auto.components.settings.SshPaneToolbar.clearFilter',
            'Clear filter'
          )}
          // Why: clearing unmounts this button; keep focus in the field being typed in.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}
