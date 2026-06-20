import React from 'react'
import { Ban, Plus, RotateCcw, Terminal } from 'lucide-react'
import {
  isDigitIndexActionId,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingInput
} from '../../../../shared/keybindings'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { ShortcutBindingSubRow } from './ShortcutBindingSubRow'
import { ShortcutRecorderButton } from './ShortcutRecorderButton'
import { ShortcutRemoveButton } from './ShortcutRemoveButton'
import type { ShortcutTerminalStatus } from './shortcut-terminal-status'
import { translate } from '@/i18n/i18n'

type ShortcutCommandBlockProps = {
  item: KeybindingDefinition
  groupTitle: string
  platform: NodeJS.Platform
  effective: readonly string[]
  modified: boolean
  error?: string
  warnings: readonly string[]
  terminalStatus?: ShortcutTerminalStatus
  // The bindings this action had right before it was disabled, so it can be
  // re-enabled with one click. Empty when there's nothing to restore.
  previousBindings: readonly string[]
  // Non-null only when this action is recording; the binding index being
  // recorded. Equal to effective.length when capturing a brand-new binding.
  recordingBindingIndex: number | null
  onStartRecordingAt: (actionId: KeybindingActionId, index: number) => void
  onAppendBinding: (actionId: KeybindingActionId) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
  onRemoveBindingAt: (actionId: KeybindingActionId, index: number) => void
  onResetAction: (actionId: KeybindingActionId) => void
  onDisableAction: (actionId: KeybindingActionId) => void
  onEnableAction: (actionId: KeybindingActionId) => void
}

export function ShortcutCommandBlock({
  item,
  groupTitle,
  platform,
  effective,
  modified,
  error,
  warnings,
  terminalStatus,
  previousBindings,
  recordingBindingIndex,
  onStartRecordingAt,
  onAppendBinding,
  onCancelRecording,
  onCapture,
  onClearError,
  onRemoveBindingAt,
  onResetAction,
  onDisableAction,
  onEnableAction
}: ShortcutCommandBlockProps): React.JSX.Element {
  const hasBinding = effective.length > 0
  const isMulti = effective.length >= 2
  // An explicit empty override means the user turned the action off entirely.
  const isDisabled = modified && !hasBinding
  const isRecording = recordingBindingIndex !== null
  const showAppendSlot = recordingBindingIndex !== null && recordingBindingIndex >= effective.length
  const isDigitIndex = isDigitIndexActionId(item.id)
  const canEnable = isDisabled && previousBindings.length > 0

  const doubleTapHint = platform === 'darwin' ? '⇧⇧' : 'Shift Shift'
  const recordingMessage = translate(
    'auto.components.settings.ShortcutCommandBlock.eb72c52c28',
    'Press a shortcut, or double-tap a modifier (e.g. {{value0}}). Esc cancels.',
    { value0: doubleTapHint }
  )
  // Errors win, then the live recording hint, then a standing conflict warning.
  const helperMessage = error
    ? error
    : isRecording
      ? recordingMessage
      : warnings.length > 0
        ? warnings.join(' ')
        : ''
  const helperTone = error || (!isRecording && warnings.length > 0) ? 'error' : 'muted'

  const recorderFor = (binding: string | null, index: number): React.JSX.Element => (
    <ShortcutRecorderButton
      actionId={item.id}
      title={item.title}
      platform={platform}
      isDigitIndex={isDigitIndex}
      binding={binding}
      bindingIndex={index}
      bindingCount={effective.length}
      recording={recordingBindingIndex === index}
      onStartRecording={onStartRecordingAt}
      onCancelRecording={onCancelRecording}
      onCapture={onCapture}
      onClearError={onClearError}
    />
  )

  return (
    <SearchableSetting
      title={item.title}
      description={translate(
        'auto.components.settings.ShortcutCommandBlock.70b5d25583',
        '{{value0}} shortcut',
        { value0: groupTitle }
      )}
      keywords={[...item.searchKeywords]}
      className="group/shortcut flex max-w-none flex-col"
    >
      <div className="flex min-h-9 items-center gap-3 rounded-md px-2 py-1 transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'truncate text-sm',
              isDisabled ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {item.title}
          </span>
          {modified ? (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {translate('auto.components.settings.ShortcutCommandBlock.287e07ddde', 'Modified')}
            </Badge>
          ) : null}
          {isDisabled ? (
            <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
              {translate('auto.components.settings.ShortcutCommandBlock.3c83cd7d1c', 'Disabled')}
            </Badge>
          ) : null}
          {terminalStatus && hasBinding ? (
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

        <div className="flex shrink-0 items-center gap-1">
          {/* Action controls reveal on hover/focus to keep the list calm. Reset
              is gated on `modified` (not on having a binding) so it's reachable
              even when the action is disabled. */}
          <div className="can-hover:opacity-0 flex items-center gap-0.5 transition-opacity group-hover/shortcut:opacity-100 group-focus-within/shortcut:opacity-100">
            {hasBinding && !showAppendSlot ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.settings.ShortcutCommandBlock.a0e2ef0e61',
                      'Add another shortcut for {{value0}}',
                      { value0: item.title }
                    )}
                    onClick={() => onAppendBinding(item.id)}
                  >
                    <Plus className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.settings.ShortcutCommandBlock.245c83af24',
                    'Add another shortcut'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {modified ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.settings.ShortcutCommandBlock.07939d084e',
                      'Reset {{value0}} to default',
                      { value0: item.title }
                    )}
                    onClick={() => onResetAction(item.id)}
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.settings.ShortcutCommandBlock.9b02917027',
                    'Reset to default'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {hasBinding ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={translate(
                      'auto.components.settings.ShortcutCommandBlock.a799f90f82',
                      'Disable {{value0}}',
                      { value0: item.title }
                    )}
                    onClick={() => onDisableAction(item.id)}
                  >
                    <Ban className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.settings.ShortcutCommandBlock.25e6e76618',
                    'Disable shortcut'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {/* Remove just the first binding (only meaningful when others
                remain; a single binding is turned off with Disable instead). */}
            {isMulti ? (
              <ShortcutRemoveButton
                actionId={item.id}
                title={item.title}
                bindingIndex={0}
                onRemove={onRemoveBindingAt}
              />
            ) : null}
          </div>

          {/* No binding: the primary affordance stays visible (the row would
              otherwise read as empty). Enable restores the pre-disable chord;
              otherwise Add records a fresh one. */}
          {!hasBinding && !showAppendSlot ? (
            canEnable ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label={translate(
                  'auto.components.settings.ShortcutCommandBlock.482a60225d',
                  'Enable {{value0}}',
                  { value0: item.title }
                )}
                onClick={() => onEnableAction(item.id)}
              >
                {translate('auto.components.settings.ShortcutCommandBlock.6287677c37', 'Enable')}
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.settings.ShortcutCommandBlock.01481b964c',
                      'Add shortcut for {{value0}}',
                      { value0: item.title }
                    )}
                    onClick={() => onAppendBinding(item.id)}
                  >
                    <Plus className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.settings.ShortcutCommandBlock.035a822ef0',
                    'Add shortcut'
                  )}
                </TooltipContent>
              </Tooltip>
            )
          ) : null}

          {/* The first binding lives inline on the command row; extras stack
              below. A single-binding action is therefore one line. */}
          {hasBinding ? recorderFor(effective[0], 0) : null}
        </div>
      </div>

      {helperMessage ? (
        <span
          className={cn(
            'block truncate px-2 text-[11px] leading-4',
            helperTone === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-live="polite"
        >
          {helperMessage}
        </span>
      ) : null}

      {/* Bindings beyond the first stack as their own rows under the command. */}
      {isMulti
        ? effective.slice(1).map((binding, offset) => {
            const index = offset + 1
            return (
              <ShortcutBindingSubRow
                // Key by slot index, not the chord: editing a binding in place
                // keeps the same recorder element so focus survives the capture.
                key={index}
                actionId={item.id}
                title={item.title}
                platform={platform}
                isDigitIndex={isDigitIndex}
                binding={binding}
                bindingIndex={index}
                bindingCount={effective.length}
                recording={recordingBindingIndex === index}
                onStartRecording={onStartRecordingAt}
                onCancelRecording={onCancelRecording}
                onCapture={onCapture}
                onClearError={onClearError}
                onRemove={onRemoveBindingAt}
              />
            )
          })
        : null}

      {showAppendSlot ? (
        <ShortcutBindingSubRow
          key="append-slot"
          actionId={item.id}
          title={item.title}
          platform={platform}
          isDigitIndex={isDigitIndex}
          binding={null}
          bindingIndex={effective.length}
          bindingCount={effective.length + 1}
          recording
          isAppendSlot
          onStartRecording={onStartRecordingAt}
          onCancelRecording={onCancelRecording}
          onCapture={onCapture}
          onClearError={onClearError}
          onRemove={onRemoveBindingAt}
        />
      ) : null}
    </SearchableSetting>
  )
}
