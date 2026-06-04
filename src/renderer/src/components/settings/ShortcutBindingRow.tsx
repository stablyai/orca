import React, { useEffect, useRef } from 'react'
import { Ban, Plus, RotateCcw, Terminal } from 'lucide-react'
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
  const hasBinding = effective.length > 0

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

  // Why: the recorder is the row's primary control — clicking the keys (or the
  // "Add shortcut" placeholder) records a new binding in place, so the whole
  // affordance lives inline rather than in a detached popover.
  const recorderLabel = recording
    ? `Press shortcut keys for ${item.title}. Escape cancels.`
    : hasBinding
      ? `Change shortcut for ${item.title}`
      : `Add shortcut for ${item.title}`

  return (
    <SearchableSetting
      title={item.title}
      description={`${groupTitle} shortcut`}
      keywords={[...item.searchKeywords]}
      className="group/shortcut relative flex min-h-[44px] max-w-none items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40 focus-within:bg-accent/40"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
        {helperMessage ? (
          <span
            className={cn(
              'block truncate text-[11px] leading-4',
              error ? 'text-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {helperMessage}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Reset/Disable reveal on hover or keyboard focus to keep the row calm;
            they stay reachable via focus-within for keyboard users. */}
        {hasBinding ? (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/shortcut:opacity-100 group-focus-within/shortcut:opacity-100">
            {modified ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Reset ${item.title} to default`}
                    onClick={() => onReset(item.id)}
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  Reset to default
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Disable ${item.title}`}
                  onClick={() => onDisable(item.id)}
                >
                  <Ban className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Disable shortcut
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={recordButtonRef}
              type="button"
              aria-label={recorderLabel}
              aria-invalid={Boolean(error)}
              aria-pressed={recording}
              data-shortcut-recorder=""
              data-shortcut-recorder-active={recording ? '' : undefined}
              onClick={() => {
                if (!recording) {
                  onStartRecording(item.id)
                }
              }}
              onKeyDown={handleRecordKeyDown}
              className={cn(
                'flex min-h-7 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                recording
                  ? 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
                  : hasBinding
                    ? 'border-transparent hover:border-border/70 hover:bg-background'
                    : 'border-dashed border-border/70 text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {recording ? (
                <span className="px-1 text-muted-foreground">Press keys…</span>
              ) : hasBinding ? (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  {effective.map((binding) => (
                    <ShortcutKeyCombo key={binding} keys={formatKeybinding(binding, platform)} />
                  ))}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Plus className="size-3" />
                  Add shortcut
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {recording ? 'Listening for shortcut' : hasBinding ? 'Change shortcut' : 'Add shortcut'}
          </TooltipContent>
        </Tooltip>
      </div>
    </SearchableSetting>
  )
}
