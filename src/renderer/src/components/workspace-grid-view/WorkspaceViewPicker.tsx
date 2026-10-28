import { useMemo, useState } from 'react'
import { Check, Terminal, FileText, Globe, MessageSquare, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { collectWorkspaceViewPanels, selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import { focusWorkspaceViewPanel } from '@/lib/workspace-view-actions'
import { workspaceViewPanelKey, WORKSPACE_VIEW_MAX_PANELS } from '@/lib/workspace-view-layout'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { translate } from '@/i18n/i18n'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '../ui/command'
import { Button } from '../ui/button'
import { useWorkspaceViewCatalogState } from './use-workspace-view-catalog-state'

function OpenWorkspaceViewPicker(): React.JSX.Element {
  useTranslation()
  const picker = useAppStore((state) => state.workspaceViewPicker)
  const view = useAppStore(selectShownWorkspaceView)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const snapshot = useWorkspaceViewCatalogState()
  const entries = useMemo(() => (snapshot ? collectWorkspaceViewPanels(snapshot) : []), [snapshot])
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof entries>()
    const ordered = picker?.workspaceId
      ? [...entries].sort(
          (a, b) =>
            Number(b.workspaceId === picker.workspaceId) -
            Number(a.workspaceId === picker.workspaceId)
        )
      : entries
    for (const entry of ordered) {
      const label = `${entry.projectName} / ${entry.workspaceName}`
      const list = groups.get(label) ?? []
      list.push(entry)
      groups.set(label, list)
    }
    return groups
  }, [entries, picker?.workspaceId])
  const inView = new Set(view?.panels.map(workspaceViewPanelKey))
  const capacity = WORKSPACE_VIEW_MAX_PANELS - (view?.panels.length ?? 0)
  function apply(keys = chosen): void {
    const state = useAppStore.getState()
    let lastId: string | null = null
    for (const entry of entries) {
      if (keys.has(workspaceViewPanelKey(entry))) {
        lastId = state.addWorkspaceViewPanel(entry, picker?.replacePanelId)
      }
    }
    if (lastId) {
      state.setWorkspaceViewPicker(null)
      focusWorkspaceViewPanel(lastId, true)
    }
  }
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          useAppStore.getState().setWorkspaceViewPicker(null)
        }
      }}
      title={
        picker?.replacePanelId
          ? translate('workspaceViews.choosePanel', 'Choose panel')
          : translate('workspaceViews.addPanel', 'Add panel')
      }
      description={translate(
        'workspaceViews.pickerDescription',
        'Choose existing panels. Their sessions stay in the original workspace.'
      )}
    >
      <CommandInput
        placeholder={translate(
          'workspaceViews.searchPanels',
          'Find a project, workspace or panel…'
        )}
      />
      <CommandList>
        <CommandEmpty>
          {translate(
            'workspaceViews.noPanels',
            'No open panels found. Open a panel in a workspace first.'
          )}
        </CommandEmpty>
        {[...grouped].map(([label, options]) => (
          <CommandGroup key={label} heading={label}>
            {options.map((entry) => {
              const key = workspaceViewPanelKey(entry),
                already = inView.has(key)
              const tab = useAppStore
                .getState()
                .unifiedTabsByWorktree[entry.workspaceId]?.find((tab) => tab.id === entry.tabId)
              const Icon =
                tab?.contentType === 'terminal'
                  ? Terminal
                  : tab?.contentType === 'browser'
                    ? Globe
                    : tab?.contentType === 'agent-session'
                      ? MessageSquare
                      : tab?.contentType === 'simulator'
                        ? Monitor
                        : FileText
              const hostLabel = selectExecutionHostDisplayLabel(
                useAppStore.getState(),
                entry.executionHostId
              )
              return (
                <CommandItem
                  key={key}
                  value={`${key} ${label} ${entry.title} ${hostLabel}`}
                  disabled={
                    already ||
                    (!picker?.replacePanelId && !chosen.has(key) && chosen.size >= capacity)
                  }
                  onSelect={() => {
                    if (picker?.replacePanelId) {
                      apply(new Set([key]))
                    } else {
                      setChosen((previous) => {
                        const next = new Set(previous)
                        if (next.has(key)) {
                          next.delete(key)
                        } else {
                          next.add(key)
                        }
                        return next
                      })
                    }
                  }}
                >
                  <Icon />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  {entry.executionHostId !== 'local' ? (
                    <span className="max-w-32 truncate text-xs text-muted-foreground">
                      {hostLabel}
                    </span>
                  ) : null}
                  {already ? (
                    <span className="text-xs text-muted-foreground">
                      {translate('workspaceViews.alreadyVisible', 'In this view')}
                    </span>
                  ) : chosen.has(key) ? (
                    <Check aria-label={translate('workspaceViews.selected', 'Selected')} />
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
      {!picker?.replacePanelId ? (
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <span className="text-xs text-muted-foreground">
            {translate('workspaceViews.selectionCount', '{{count}} selected', {
              count: chosen.size
            })}
          </span>
          <Button size="sm" disabled={!chosen.size} onClick={() => apply()}>
            {translate('workspaceViews.addSelected', 'Add selected panels')}
          </Button>
        </div>
      ) : null}
    </CommandDialog>
  )
}

export function WorkspaceViewPicker(): React.JSX.Element | null {
  const picker = useAppStore((state) => state.workspaceViewPicker)
  return picker ? <OpenWorkspaceViewPicker /> : null
}
