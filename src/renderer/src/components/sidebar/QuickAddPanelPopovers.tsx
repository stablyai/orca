import React from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import type { PinnedWebPanel } from '../../../../shared/types'
import {
  MAX_PINNED_WEB_PANELS,
  normalizePinnedWebPanels
} from '../../../../shared/pinned-web-panels'
import {
  MAX_PINNED_TERMINAL_PANELS,
  normalizePinnedTerminalPanels
} from '../../../../shared/pinned-terminal-panels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { emptyDraft, panelFromDraft } from '@/components/settings/pinned-terminal-panel-drafts'

/**
 * Compact + on User Panels: create a web panel without opening Settings.
 *
 * Why no Tooltip wrapper: Tooltip+Popover asChild nesting was in the crash
 * stack for React #185 (max update depth) at boot. Native title is enough.
 * Why scalar store selectors: selecting `settings?.pinnedWebPanels ?? []`
 * (even with a module EMPTY) still re-subscribed through full settings churn;
 * only length/actions are read from the store during render.
 */
export function QuickAddWebPanelButton(): React.JSX.Element {
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openPinnedWebPanelPage = useAppStore((s) => s.openPinnedWebPanelPage)
  const atCap = useAppStore(
    (s) => (s.settings?.pinnedWebPanels?.length ?? 0) >= MAX_PINNED_WEB_PANELS
  )
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [url, setUrl] = React.useState('')

  const urlValid = React.useMemo(() => {
    try {
      const parsed = new URL(url.trim())
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }, [url])

  const submit = (): void => {
    if (!urlValid || atCap) {
      return
    }
    const panels = useAppStore.getState().settings?.pinnedWebPanels ?? []
    if (panels.length >= MAX_PINNED_WEB_PANELS) {
      return
    }
    const id = crypto.randomUUID()
    const panel: PinnedWebPanel = {
      id,
      title: title.trim(),
      url: url.trim()
    }
    // Why: normalize on write so a typo/scheme error cannot land in settings.
    const next = normalizePinnedWebPanels([...panels, panel])
    void updateSettings({
      pinnedWebPanels: next,
      pinnedWebPanelsCollapsed: false
    })
    setTitle('')
    setUrl('')
    setOpen(false)
    if (next.some((p) => p.id === id)) {
      openPinnedWebPanelPage(id)
    }
  }

  const addLabel = translate(
    'auto.components.sidebar.QuickAddPanelPopovers.addWebPanel',
    'Add browser panel'
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80"
          disabled={atCap}
          aria-label={addLabel}
          title={addLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="w-72 space-y-2 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-[12px] font-medium">
          {translate('auto.components.sidebar.QuickAddPanelPopovers.webTitle', 'New user panel')}
        </div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={translate(
            'auto.components.settings.PinnedWebPanelsSetting.titlePlaceholder',
            'Title'
          )}
          className="h-7 text-[12px]"
        />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submit()
            }
          }}
          placeholder="https://…"
          className="h-7 text-[12px]"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-full"
          disabled={!urlValid || atCap}
          onClick={submit}
        >
          {translate('auto.components.settings.PinnedWebPanelsSetting.add', 'Add')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

/** Compact + on Nodes: create a terminal panel (local or SSH host). */
export function QuickAddTerminalPanelButton(): React.JSX.Element {
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openPinnedTerminalPanelPage = useAppStore((s) => s.openPinnedTerminalPanelPage)
  const atCap = useAppStore(
    (s) => (s.settings?.pinnedTerminalPanels?.length ?? 0) >= MAX_PINNED_TERMINAL_PANELS
  )
  // Why: Map identity can churn; only re-render when the label set changes.
  const hostSuggestionsKey = useAppStore((s) => {
    const labels = s.sshTargetLabels
    if (!labels || labels.size === 0) {
      return ''
    }
    return [...labels.values()].sort().join('\0')
  })
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(emptyDraft)

  const hostSuggestions = React.useMemo(
    () => (hostSuggestionsKey.length === 0 ? [] : hostSuggestionsKey.split('\0')),
    [hostSuggestionsKey]
  )
  const canSubmit = draft.command.trim().length > 0 && !atCap

  const submit = (): void => {
    if (!canSubmit) {
      return
    }
    const panels = useAppStore.getState().settings?.pinnedTerminalPanels ?? []
    if (panels.length >= MAX_PINNED_TERMINAL_PANELS) {
      return
    }
    const id = crypto.randomUUID()
    const panel = panelFromDraft(draft, { id })
    const next = normalizePinnedTerminalPanels([...panels, panel])
    void updateSettings({ pinnedTerminalPanels: next })
    setDraft(emptyDraft)
    setOpen(false)
    if (next.some((p) => p.id === id)) {
      openPinnedTerminalPanelPage(id)
    }
  }

  const addLabel = translate(
    'auto.components.sidebar.QuickAddPanelPopovers.addTerminalPanel',
    'Add node terminal'
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80"
          disabled={atCap}
          aria-label={addLabel}
          title={addLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="w-72 space-y-2 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-[12px] font-medium">
          {translate(
            'auto.components.sidebar.QuickAddPanelPopovers.terminalTitle',
            'New node panel'
          )}
        </div>
        <Input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder={translate(
            'auto.components.settings.PinnedTerminalPanelsSetting.titlePlaceholder',
            'Title'
          )}
          className="h-7 text-[12px]"
        />
        <Input
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submit()
            }
          }}
          placeholder={translate(
            'auto.components.sidebar.QuickAddPanelPopovers.commandPlaceholder',
            'Command (e.g. btop)'
          )}
          className="h-7 text-[12px]"
        />
        <Input
          value={draft.host}
          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          list="quick-add-terminal-hosts"
          placeholder={translate(
            'auto.components.settings.PinnedTerminalPanelsSetting.hostPlaceholder',
            'Host (empty = local)'
          )}
          className="h-7 text-[12px]"
        />
        <datalist id="quick-add-terminal-hosts">
          {hostSuggestions.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-full"
          disabled={!canSubmit}
          onClick={submit}
        >
          {translate('auto.components.settings.PinnedTerminalPanelsSetting.add', 'Add')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
