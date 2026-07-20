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
import { translate } from '@/i18n/i18n'
import { emptyDraft, panelFromDraft } from '@/components/settings/pinned-terminal-panel-drafts'

/**
 * Compact + on User Panels / Nodes.
 *
 * Mount path is intentionally dumb: the always-visible rail only renders a
 * button with local useState. Forms (and any store reads) mount only after
 * click. Packaged boot was React #185 (max update depth / forceStoreRerender)
 * when Popover + useAppStore lived on the rail itself.
 */

export function QuickAddWebForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [title, setTitle] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [atCap, setAtCap] = React.useState(
    () => (useAppStore.getState().settings?.pinnedWebPanels?.length ?? 0) >= MAX_PINNED_WEB_PANELS
  )

  React.useEffect(() => {
    setAtCap(
      (useAppStore.getState().settings?.pinnedWebPanels?.length ?? 0) >= MAX_PINNED_WEB_PANELS
    )
  }, [])

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
    const next = normalizePinnedWebPanels([...panels, panel])
    void useAppStore.getState().updateSettings({
      pinnedWebPanels: next,
      pinnedWebPanelsCollapsed: false
    })
    if (next.some((p) => p.id === id)) {
      useAppStore.getState().openPinnedWebPanelPage(id)
    }
    onDone()
  }

  return (
    <div
      className="mx-1 mb-1 space-y-2 rounded-md border border-worktree-sidebar-border/40 bg-worktree-sidebar-background p-2"
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
        autoFocus
      />
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            submit()
          } else if (e.key === 'Escape') {
            onDone()
          }
        }}
        placeholder="https://…"
        className="h-7 text-[12px]"
      />
      <div className="flex gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 flex-1"
          disabled={!urlValid || atCap}
          onClick={submit}
        >
          {translate('auto.components.settings.PinnedWebPanelsSetting.add', 'Add')}
        </Button>
        <Button variant="ghost" size="sm" className="h-7" onClick={onDone}>
          {translate('auto.common.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

export function QuickAddTerminalForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [draft, setDraft] = React.useState(emptyDraft)
  const hostSuggestions = React.useMemo(() => {
    const labels = useAppStore.getState().sshTargetLabels
    if (!labels || labels.size === 0) {
      return [] as string[]
    }
    return [...labels.values()].sort()
  }, [])
  const [atCap, setAtCap] = React.useState(
    () =>
      (useAppStore.getState().settings?.pinnedTerminalPanels?.length ?? 0) >=
      MAX_PINNED_TERMINAL_PANELS
  )

  React.useEffect(() => {
    setAtCap(
      (useAppStore.getState().settings?.pinnedTerminalPanels?.length ?? 0) >=
        MAX_PINNED_TERMINAL_PANELS
    )
  }, [])

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
    void useAppStore.getState().updateSettings({ pinnedTerminalPanels: next })
    if (next.some((p) => p.id === id)) {
      useAppStore.getState().openPinnedTerminalPanelPage(id)
    }
    onDone()
  }

  return (
    <div
      className="mx-1 mb-1 space-y-2 rounded-md border border-worktree-sidebar-border/40 bg-worktree-sidebar-background p-2"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="text-[12px] font-medium">
        {translate('auto.components.sidebar.QuickAddPanelPopovers.terminalTitle', 'New node panel')}
      </div>
      <Input
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        placeholder={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.titlePlaceholder',
          'Title'
        )}
        className="h-7 text-[12px]"
        autoFocus
      />
      <Input
        value={draft.command}
        onChange={(e) => setDraft({ ...draft, command: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            submit()
          } else if (e.key === 'Escape') {
            onDone()
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
      <div className="flex gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 flex-1"
          disabled={!canSubmit}
          onClick={submit}
        >
          {translate('auto.components.settings.PinnedTerminalPanelsSetting.add', 'Add')}
        </Button>
        <Button variant="ghost" size="sm" className="h-7" onClick={onDone}>
          {translate('auto.common.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

/** Always-mounted rail control: local state only, no store, no Radix. */
export function QuickAddWebPanelButton({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const addLabel = translate(
    'auto.components.sidebar.QuickAddPanelPopovers.addWebPanel',
    'Add browser panel'
  )
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80"
      aria-label={addLabel}
      title={addLabel}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation()
        onOpenChange(!open)
      }}
    >
      <Plus className="size-3.5" strokeWidth={2.25} />
    </Button>
  )
}

/** Always-mounted rail control: local state only, no store, no Radix. */
export function QuickAddTerminalPanelButton({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const addLabel = translate(
    'auto.components.sidebar.QuickAddPanelPopovers.addTerminalPanel',
    'Add node terminal'
  )
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-worktree-sidebar-foreground/50 hover:text-worktree-sidebar-foreground/80"
      aria-label={addLabel}
      title={addLabel}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation()
        onOpenChange(!open)
      }}
    >
      <Plus className="size-3.5" strokeWidth={2.25} />
    </Button>
  )
}
