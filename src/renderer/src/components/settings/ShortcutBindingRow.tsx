import React, { useEffect, useRef } from 'react'
import { Ban, Keyboard, RotateCcw } from 'lucide-react'
import {
  formatKeybinding,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingInput
} from '../../../../shared/keybindings'
import { cn } from '../../lib/utils'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

type ShortcutBindingRowProps = {
  item: KeybindingDefinition
  groupTitle: string
  platform: NodeJS.Platform
  effective: readonly string[]
  modified: boolean
  error?: string
  warnings: readonly string[]
  recording: boolean
  onStartRecording: (actionId: KeybindingActionId) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
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
  modified,
  error,
  warnings,
  recording,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onClearError,
  onDisable,
  onReset
}: ShortcutBindingRowProps): React.JSX.Element {
  const recordButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (recording) {
      recordButtonRef.current?.focus()
    }
  }, [recording])

  const handleRecordKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onStartRecording(item.id)
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      onClearError(item.id)
      onCancelRecording()
      return
    }

    onClearError(item.id)
    onCapture(item.id, {
      key: event.key,
      code: event.code,
      alt: event.altKey,
      meta: event.metaKey,
      control: event.ctrlKey,
      shift: event.shiftKey
    })
  }

  return (
    <SearchableSetting
      title={item.title}
      description={`${groupTitle} shortcut`}
      keywords={[...item.searchKeywords]}
      className="grid grid-cols-1 items-start gap-3 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] lg:gap-4"
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

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            ref={recordButtonRef}
            type="button"
            variant={recording ? 'secondary' : 'outline'}
            size="sm"
            aria-invalid={Boolean(error)}
            aria-pressed={recording}
            onClick={() => {
              if (recording) {
                return
              }
              onStartRecording(item.id)
            }}
            onKeyDown={handleRecordKeyDown}
            className={cn(
              'h-8 min-w-36 justify-start px-2.5 text-xs',
              recording && 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
            )}
          >
            <Keyboard className="size-3.5" />
            <span className="truncate">{recording ? 'Press keys...' : 'Change shortcut'}</span>
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => onDisable(item.id)}>
            <Ban className="size-3" />
            Disable
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => onReset(item.id)}>
            <RotateCcw className="size-3" />
            Reset
          </Button>
        </div>
        {recording ? (
          <p className="text-right text-[11px] text-muted-foreground">Esc cancels recording.</p>
        ) : null}
      </div>
    </SearchableSetting>
  )
}
