import React from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { GlobalSettings, PinnedTerminalPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  MAX_PINNED_TERMINAL_PANELS,
  movePinnedTerminalPanel,
  resolvePinnedTerminalPanelSshTargetIdFromLabels
} from '../../../../shared/pinned-terminal-panels'
import { prunePanelLayoutsForSurvivingPanels } from '../../../../shared/panel-layouts'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { PanelEditRow, PanelRow } from './PinnedTerminalPanelRows'
import {
  GROUP_DATALIST_ID,
  HOST_DATALIST_ID,
  type PanelDraft,
  draftFromPanel,
  emptyDraft,
  panelFromDraft
} from './pinned-terminal-panel-drafts'

type PinnedTerminalPanelsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function getPinnedTerminalPanelsEntry(): {
  title: string
  description: string
  keywords: string[]
} {
  return {
    title: translate(
      'auto.components.settings.PinnedTerminalPanelsSetting.title',
      'Pinned terminal panels'
    ),
    description: translate(
      'auto.components.settings.PinnedTerminalPanelsSetting.description',
      'Pin observability commands (nvtop, btop, watch …) to the sidebar as persistent terminals.'
    ),
    keywords: ['pinned', 'panel', 'terminal', 'nvtop', 'btop', 'observability', 'sidebar']
  }
}

export function PinnedTerminalPanelsSearchableSetting({
  settings,
  updateSettings,
  forceVisible
}: PinnedTerminalPanelsSettingProps & { forceVisible: boolean }): React.JSX.Element {
  const entry = getPinnedTerminalPanelsEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-2"
      forceVisible={forceVisible}
    >
      <PinnedTerminalPanelsSetting settings={settings} updateSettings={updateSettings} />
    </SearchableSetting>
  )
}

export function PinnedTerminalPanelsSetting({
  settings,
  updateSettings
}: PinnedTerminalPanelsSettingProps): React.JSX.Element {
  const panels = React.useMemo(
    () => settings.pinnedTerminalPanels ?? [],
    [settings.pinnedTerminalPanels]
  )
  const sectionEnabled = settings.pinnedTerminalPanelsEnabled !== false
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshTargetsHydrated = useAppStore((s) => s.sshTargetsHydrated)
  const [draft, setDraft] = React.useState<PanelDraft>(emptyDraft)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editDraft, setEditDraft] = React.useState<PanelDraft>(emptyDraft)

  // Why: settings unit tests (and pre-hydration boot) can mount this surface
  // before sshTargetLabels is a Map. Never call .values() on undefined.
  const hostSuggestions = React.useMemo(
    () => [...new Set((sshTargetLabels ?? new Map<string, string>()).values())].sort(),
    [sshTargetLabels]
  )
  const groupSuggestions = React.useMemo(
    () =>
      [
        ...new Set(panels.map((panel) => panel.group).filter((g): g is string => Boolean(g)))
      ].sort(),
    [panels]
  )

  // Why: only warn once the target list actually loaded — before hydration an
  // empty label map would flag every hosted panel as a typo.
  const isHostUnresolved = React.useCallback(
    (host: string | undefined): boolean =>
      sshTargetsHydrated &&
      typeof host === 'string' &&
      host.length > 0 &&
      resolvePinnedTerminalPanelSshTargetIdFromLabels(sshTargetLabels, host) === null,
    [sshTargetsHydrated, sshTargetLabels]
  )

  const sensors = useSensors(
    // Why: an activation distance keeps row buttons (edit, delete …) clickable
    // — a press only becomes a drag after actual movement.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const setPanels = (next: readonly PinnedTerminalPanel[]): void => {
    updateSettings({ pinnedTerminalPanels: [...next] })
  }

  const addPanel = (): void => {
    if (draft.command.trim().length === 0 || panels.length >= MAX_PINNED_TERMINAL_PANELS) {
      return
    }
    setPanels([...panels, panelFromDraft(draft, { id: crypto.randomUUID() })])
    setDraft(emptyDraft)
  }

  const removePanel = (id: string): void => {
    const next = panels.filter((panel) => panel.id !== id)
    const state = useAppStore.getState()
    updateSettings({
      pinnedTerminalPanels: [...next],
      // Why: a saved layout pointing at a deleted panel renders a dead tile.
      panelLayouts: prunePanelLayoutsForSurvivingPanels(
        state.settings?.panelLayouts,
        next,
        state.settings?.pinnedWebPanels ?? []
      )
    })
    if (editingId === id) {
      setEditingId(null)
    }
  }

  const duplicatePanel = (source: PinnedTerminalPanel): void => {
    if (panels.length >= MAX_PINNED_TERMINAL_PANELS) {
      return
    }
    const index = panels.findIndex((panel) => panel.id === source.id)
    const copy: PinnedTerminalPanel = { ...source, id: crypto.randomUUID() }
    const next = [...panels]
    next.splice(index + 1, 0, copy)
    setPanels(next)
  }

  const togglePanelEnabled = (id: string): void => {
    setPanels(
      panels.map((panel) => {
        if (panel.id !== id) {
          return panel
        }
        if (panel.enabled === false) {
          // Why: drop the key rather than store enabled: true — absent is the
          // enabled state, keeping persisted profiles minimal.
          const { enabled: _enabled, ...rest } = panel
          return rest
        }
        return { ...panel, enabled: false }
      })
    )
  }

  const beginEdit = (panel: PinnedTerminalPanel): void => {
    setEditingId(panel.id)
    setEditDraft(draftFromPanel(panel))
  }

  const commitEdit = (): void => {
    if (editingId === null || editDraft.command.trim().length === 0) {
      return
    }
    setPanels(
      panels.map((panel) =>
        panel.id === editingId
          ? panelFromDraft(editDraft, { id: panel.id, enabled: panel.enabled })
          : panel
      )
    )
    setEditingId(null)
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const overId = event.over?.id
    if (typeof overId !== 'string' || typeof event.active.id !== 'string') {
      return
    }
    const next = movePinnedTerminalPanel(panels, event.active.id, overId)
    if (next !== panels) {
      setPanels(next)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span
          className="text-[12px] text-muted-foreground"
          id="pinned-terminal-panels-enabled-label"
        >
          {translate(
            'auto.components.settings.PinnedTerminalPanelsSetting.sectionEnabled',
            'Show panels in the sidebar'
          )}
        </span>
        <SettingsSwitch
          checked={sectionEnabled}
          ariaLabelledBy="pinned-terminal-panels-enabled-label"
          onChange={() => updateSettings({ pinnedTerminalPanelsEnabled: !sectionEnabled })}
        />
      </div>
      <datalist id={HOST_DATALIST_ID}>
        {hostSuggestions.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <datalist id={GROUP_DATALIST_ID}>
        {groupSuggestions.map((group) => (
          <option key={group} value={group} />
        ))}
      </datalist>
      {panels.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={panels.map((panel) => panel.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="divide-y divide-border/40 rounded-md border border-border/60">
              {panels.map((panel) =>
                editingId === panel.id ? (
                  <PanelEditRow
                    key={panel.id}
                    draft={editDraft}
                    setDraft={setEditDraft}
                    onCommit={commitEdit}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <PanelRow
                    key={panel.id}
                    panel={panel}
                    hostUnresolved={isHostUnresolved(panel.host)}
                    atCap={panels.length >= MAX_PINNED_TERMINAL_PANELS}
                    onToggleEnabled={() => togglePanelEnabled(panel.id)}
                    onEdit={() => beginEdit(panel)}
                    onDuplicate={() => duplicatePanel(panel)}
                    onRemove={() => removePanel(panel.id)}
                  />
                )
              )}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}
      {panels.length < MAX_PINNED_TERMINAL_PANELS ? (
        <div className="flex items-center gap-2">
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.titlePlaceholder',
              'Title'
            )}
            className="h-7 w-32 text-[12px]"
          />
          <Input
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPanel()
              }
            }}
            placeholder="nvtop"
            className="h-7 flex-1 font-mono text-[12px]"
          />
          <Input
            value={draft.group}
            onChange={(e) => setDraft({ ...draft, group: e.target.value })}
            list={GROUP_DATALIST_ID}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.groupPlaceholder',
              'Group'
            )}
            className="h-7 w-24 text-[12px]"
          />
          <Input
            value={draft.host}
            onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPanel()
              }
            }}
            list={HOST_DATALIST_ID}
            placeholder={translate(
              'auto.components.settings.PinnedTerminalPanelsSetting.hostPlaceholder',
              'SSH host (optional)'
            )}
            className="h-7 w-36 font-mono text-[12px]"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-7"
            disabled={draft.command.trim().length === 0}
            onClick={addPanel}
          >
            {translate('auto.components.settings.PinnedTerminalPanelsSetting.add', 'Add')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
