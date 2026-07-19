import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Check, Copy, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { SettingsSwitch } from './SettingsFormControls'
import {
  GROUP_DATALIST_ID,
  HOST_DATALIST_ID,
  type PanelDraft
} from './pinned-terminal-panel-drafts'

export function PanelRow({
  panel,
  hostUnresolved,
  atCap,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onRemove
}: {
  panel: PinnedTerminalPanel
  hostUnresolved: boolean
  atCap: boolean
  onToggleEnabled: () => void
  onEdit: () => void
  onDuplicate: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.id
  })
  const disabled = panel.enabled === false
  return (
    <div
      ref={setNodeRef}
      style={{
        // Why: @dnd-kit/utilities isn't a dependency; the translate string is
        // trivial to build and sortable only ever needs a translation.
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition
      }}
      className={
        isDragging
          ? 'relative z-10 flex items-center gap-2 bg-background px-2 py-1.5 opacity-80 shadow-md'
          : 'flex items-center gap-2 px-2 py-1.5'
      }
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.reorder',
          'Reorder panel'
        )}
        className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" strokeWidth={1.75} />
      </button>
      <SettingsSwitch
        checked={!disabled}
        ariaLabel={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.panelEnabled',
          'Show this panel'
        )}
        onChange={onToggleEnabled}
      />
      <div className={disabled ? 'min-w-0 flex-1 opacity-50' : 'min-w-0 flex-1'}>
        <div className="truncate text-[13px] font-medium">
          {panel.group ? `${panel.group} / ` : ''}
          {panel.title}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {panel.command}
          {panel.host ? ` @ ${panel.host}` : ''}
        </div>
      </div>
      {hostUnresolved ? (
        <span
          className="shrink-0 rounded border border-amber-500/50 px-1 py-px text-[10px] font-medium text-amber-500"
          title={translate(
            'auto.components.settings.PinnedTerminalPanelsSetting.unresolvedHostTitle',
            'No configured SSH target matches this host — the panel will refuse to start.'
          )}
        >
          {translate(
            'auto.components.settings.PinnedTerminalPanelsSetting.unresolvedHost',
            'unresolved host'
          )}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.edit',
          'Edit panel'
        )}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" strokeWidth={1.75} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        disabled={atCap}
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.duplicate',
          'Duplicate panel'
        )}
        onClick={onDuplicate}
      >
        <Copy className="size-3.5" strokeWidth={1.75} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.remove',
          'Remove panel'
        )}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" strokeWidth={1.75} />
      </Button>
    </div>
  )
}

export function PanelEditRow({
  draft,
  setDraft,
  onCommit,
  onCancel
}: {
  draft: PanelDraft
  setDraft: (draft: PanelDraft) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      onCommit()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Input
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.titlePlaceholder',
          'Title'
        )}
        className="h-7 w-32 text-[12px]"
      />
      <Input
        value={draft.command}
        onChange={(e) => setDraft({ ...draft, command: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder="nvtop"
        className="h-7 flex-1 font-mono text-[12px]"
      />
      <Input
        value={draft.group}
        onChange={(e) => setDraft({ ...draft, group: e.target.value })}
        onKeyDown={onKeyDown}
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
        onKeyDown={onKeyDown}
        list={HOST_DATALIST_ID}
        placeholder={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.hostPlaceholder',
          'SSH host (optional)'
        )}
        className="h-7 w-36 font-mono text-[12px]"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        disabled={draft.command.trim().length === 0}
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.saveEdit',
          'Save panel'
        )}
        onClick={onCommit}
      >
        <Check className="size-3.5" strokeWidth={1.75} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={translate(
          'auto.components.settings.PinnedTerminalPanelsSetting.cancelEdit',
          'Cancel edit'
        )}
        onClick={onCancel}
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </Button>
    </div>
  )
}
