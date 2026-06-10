import React from 'react'
import type { KeybindingActionId, KeybindingInput } from '../../../../shared/keybindings'
import { cn } from '../../lib/utils'
import { ShortcutBindingRow } from './ShortcutBindingRow'
import type { ShortcutRowsByGroup } from './ShortcutFilterRail'
import { translate } from '@/i18n/i18n'

export function ShortcutRowsList({
  className,
  groups,
  platform,
  errors,
  recordingActionId,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onClearError,
  onDisable,
  onReset
}: {
  className?: string
  groups: ShortcutRowsByGroup[]
  platform: NodeJS.Platform
  errors: Partial<Record<KeybindingActionId, string>>
  recordingActionId: KeybindingActionId | null
  onStartRecording: (actionId: KeybindingActionId) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
  onDisable: (actionId: KeybindingActionId) => void
  onReset: (actionId: KeybindingActionId) => void
}): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <div
        className={cn(
          'rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground',
          className
        )}
      >
        {translate("auto.components.settings.ShortcutRowsList.4ce3cd24d9", "No shortcuts match those filters.")}</div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-8', className)}>
      {groups.map((group) => (
        <div key={group.title} className="space-y-3">
          <h3 className="border-b border-border/50 pb-2 text-sm font-medium text-muted-foreground">
            {group.title}
          </h3>
          <div className="grid gap-2">
            {group.rows.map((row) => (
              <ShortcutBindingRow
                key={row.item.id}
                item={row.item}
                groupTitle={group.title}
                platform={platform}
                effective={row.effective}
                modified={row.modified}
                error={errors[row.item.id]}
                warnings={row.warnings}
                recording={recordingActionId === row.item.id}
                terminalStatus={row.terminalStatus}
                onStartRecording={onStartRecording}
                onCancelRecording={onCancelRecording}
                onCapture={onCapture}
                onClearError={onClearError}
                onDisable={onDisable}
                onReset={onReset}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
