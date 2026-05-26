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
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'
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
      <span className="flex min-h-7 items-center">
        <span className="text-xs text-muted-foreground">Unassigned</span>
      </span>
    )
  }
  return (
    <span className="flex min-h-7 flex-wrap items-center justify-start gap-1.5">
      {bindings.map((binding) => (
        <ShortcutKeyCombo key={binding} keys={formatKeybinding(binding, platform)} />
      ))}
    </span>
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
      className="group relative grid min-h-[54px] max-w-none grid-cols-1 gap-x-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40 lg:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)] lg:grid-rows-[minmax(1.75rem,auto)_1rem] lg:items-start"
    >
      <div className="flex min-w-0 items-center gap-2 lg:col-start-1 lg:row-start-1 lg:self-center">
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
          'h-[16px] overflow-hidden text-[11px] leading-4 lg:col-start-1 lg:row-start-2',
          error ? 'text-destructive' : 'text-muted-foreground'
        )}
        aria-live="polite"
      >
        {helperMessage ? <span className="block truncate">{helperMessage}</span> : null}
      </div>

      <HoverCard openDelay={0} closeDelay={80}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`Shortcut actions for ${item.title}`}
            className="mt-1 flex min-w-0 items-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:self-center lg:justify-self-end"
          >
            <BindingPreview bindings={effective} platform={platform} />
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="w-auto max-w-[min(22rem,calc(100vw-2rem))] p-1"
        >
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={recordButtonRef}
                  type="button"
                  variant={recording ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  aria-label={
                    recording
                      ? `Press shortcut keys for ${item.title}. Escape cancels.`
                      : `Change shortcut for ${item.title}`
                  }
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
                    'text-muted-foreground hover:text-foreground',
                    recording &&
                      'border border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
                  )}
                >
                  <Keyboard className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {recording ? 'Listening for shortcut' : 'Change shortcut'}
              </TooltipContent>
            </Tooltip>
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
        </HoverCardContent>
      </HoverCard>
    </SearchableSetting>
  )
}
