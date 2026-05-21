import React from 'react'
import { RotateCcw, Save, X } from 'lucide-react'
import {
  formatKeybinding,
  type KeybindingActionId,
  type KeybindingDefinition
} from '../../../../shared/keybindings'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'

type ShortcutBindingRowProps = {
  item: KeybindingDefinition
  groupTitle: string
  platform: NodeJS.Platform
  effective: readonly string[]
  draft: string
  modified: boolean
  error?: string
  warnings: readonly string[]
  onDraftChange: (actionId: KeybindingActionId, value: string) => void
  onClearError: (actionId: KeybindingActionId) => void
  onCommit: (actionId: KeybindingActionId) => void
  onDisable: (actionId: KeybindingActionId) => void
  onReset: (actionId: KeybindingActionId) => void
}

function BindingPreview({
  bindings,
  platform
}: {
  bindings: readonly string[]
  platform: NodeJS.Platform
}): React.JSX.Element {
  if (bindings.length === 0) {
    return <span className="text-xs text-muted-foreground">Unassigned</span>
  }
  return (
    <div className="flex flex-wrap justify-start gap-1.5">
      {bindings.map((binding) => (
        <ShortcutKeyCombo key={binding} keys={formatKeybinding(binding, platform)} />
      ))}
    </div>
  )
}

export function ShortcutBindingRow({
  item,
  groupTitle,
  platform,
  effective,
  draft,
  modified,
  error,
  warnings,
  onDraftChange,
  onClearError,
  onCommit,
  onDisable,
  onReset
}: ShortcutBindingRowProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={item.title}
      description={`${groupTitle} shortcut`}
      keywords={[...item.searchKeywords]}
      className="grid grid-cols-1 items-start gap-3 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:gap-4"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{item.title}</span>
          {modified ? (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              Modified
            </Badge>
          ) : null}
        </div>
        <BindingPreview bindings={effective} platform={platform} />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {warnings.map((warning) => (
          <p key={warning} className="text-xs text-muted-foreground">
            {warning}
          </p>
        ))}
      </div>

      <div className="min-w-0 space-y-2">
        <Input
          value={draft}
          placeholder="Ctrl+Shift+P"
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            onDraftChange(item.id, event.target.value)
            onClearError(item.id)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommit(item.id)
            }
          }}
          className="h-8 text-xs"
        />
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={() => onDisable(item.id)}>
            <X className="size-3" />
            Disable
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => onReset(item.id)}>
            <RotateCcw className="size-3" />
            Reset
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => onCommit(item.id)}>
            <Save className="size-3" />
            Save
          </Button>
        </div>
      </div>
    </SearchableSetting>
  )
}
