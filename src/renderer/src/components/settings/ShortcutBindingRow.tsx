import React, { useEffect, useRef } from 'react'
import { Ban, Keyboard, RotateCcw, Terminal } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
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
  terminalStatus?: ShortcutTerminalStatus
  onStartRecording: (actionId: KeybindingActionId) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
  onDisable: (actionId: KeybindingActionId) => void
  onReset: (actionId: KeybindingActionId) => void
}

export type ShortcutTerminalStatus = {
  label: string
  description: string
}

function BindingPreview({
  bindings,
  platform
}: {
  bindings: readonly string[]
  platform: NodeJS.Platform
}): React.JSX.Element {
  if (bindings.length === 0) {
    return (
      <div className="flex min-h-7 items-center">
        <span className="text-xs text-muted-foreground">Unassigned</span>
      </div>
    )
  }
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-start gap-1.5">
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
  terminalStatus,
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
    window.api.ui.setShortcutRecorderFocused(recording)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recording])

  const statusMessage = error ?? (warnings.length > 0 ? warnings.join(' ') : '')
  const recordingMessage = recording ? 'Listening for shortcut. Esc cancels recording.' : ''
  const helperMessage = statusMessage || recordingMessage

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
      className="grid min-h-[54px] grid-cols-1 gap-x-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40 lg:grid-cols-[minmax(0,1.1fr)_minmax(10rem,0.8fr)_10rem_4rem] lg:items-center"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{item.title}</span>
          {modified ? (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              Modified
            </Badge>
          ) : null}
          {terminalStatus ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="shrink-0 gap-1 border-border/70 text-[11px] text-muted-foreground"
                >
                  <Terminal className="size-3" />
                  {terminalStatus.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {terminalStatus.description}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div
          className={cn(
            'h-[16px] overflow-hidden text-[11px] leading-4',
            error ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-live="polite"
        >
          {helperMessage ? <span className="block truncate">{helperMessage}</span> : null}
        </div>
      </div>

      <div className="mt-1 min-w-0 lg:mt-0">
        <BindingPreview bindings={effective} platform={platform} />
      </div>

      <Button
        ref={recordButtonRef}
        type="button"
        variant={recording ? 'secondary' : 'outline'}
        size="sm"
        aria-invalid={Boolean(error)}
        aria-pressed={recording}
        data-shortcut-recorder=""
        data-shortcut-recorder-active={recording ? '' : undefined}
        onClick={() => {
          if (recording) {
            return
          }
          onStartRecording(item.id)
        }}
        onKeyDown={handleRecordKeyDown}
        className={cn(
          'mt-2 h-8 w-full justify-start px-2.5 text-xs lg:mt-0 lg:w-40',
          !recording &&
            'border-border/70 bg-background/60 text-foreground/80 shadow-none hover:border-border hover:bg-accent/70 hover:text-foreground dark:text-foreground dark:shadow-xs',
          recording && 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
        )}
      >
        <Keyboard className="size-3.5" />
        <span className="truncate">{recording ? 'Press keys...' : 'Change shortcut'}</span>
      </Button>

      <div className="mt-2 flex items-center gap-1 lg:mt-0 lg:justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Disable ${item.title}`}
              onClick={() => onDisable(item.id)}
            >
              <Ban className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Disable
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Reset ${item.title}`}
              onClick={() => onReset(item.id)}
            >
              <RotateCcw className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Reset
          </TooltipContent>
        </Tooltip>
      </div>
    </SearchableSetting>
  )
}
