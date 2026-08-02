import React from 'react'
import type { KeybindingActionId, KeybindingInput } from '../../../../shared/keybindings'
import { ShortcutRecorderButton } from './ShortcutRecorderButton'
import { ShortcutRemoveButton } from './ShortcutRemoveButton'

type ShortcutBindingSubRowProps = {
  actionId: KeybindingActionId
  title: string
  platform: NodeJS.Platform
  isDigitIndex: boolean
  // The chord this row edits, or null for the transient "add a new binding" slot.
  binding: string | null
  bindingIndex: number
  bindingCount: number
  recording: boolean
  isAppendSlot?: boolean
  onStartRecording: (actionId: KeybindingActionId, index: number) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
  onRemove: (actionId: KeybindingActionId, index: number) => void
}

// A second-or-later binding of an action. The chord sits at the right edge (so
// chips line up with the binding on the command row); the remove control reveals
// on hover.
export function ShortcutBindingSubRow({
  actionId,
  title,
  platform,
  isDigitIndex,
  binding,
  bindingIndex,
  bindingCount,
  recording,
  isAppendSlot = false,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onClearError,
  onRemove
}: ShortcutBindingSubRowProps): React.JSX.Element {
  return (
    <div className="group/binding flex min-h-8 items-center gap-1 rounded-md py-0.5 pr-2 pl-5 transition-colors hover:bg-accent/30">
      <div className="min-w-0 flex-1" />
      {/* Remove reveals on hover/focus to keep the row calm; keyboard users
          reach it via focus-within. The append slot reserves the column with an
          invisible spacer so the recorder stays aligned across rows. */}
      {isAppendSlot ? (
        <span className="size-6 shrink-0" aria-hidden="true" />
      ) : (
        <div className="can-hover:opacity-0 shrink-0 transition-opacity group-hover/binding:opacity-100 group-focus-within/binding:opacity-100">
          <ShortcutRemoveButton
            actionId={actionId}
            title={title}
            bindingIndex={bindingIndex}
            onRemove={onRemove}
          />
        </div>
      )}
      <div className="shrink-0">
        <ShortcutRecorderButton
          actionId={actionId}
          title={title}
          platform={platform}
          isDigitIndex={isDigitIndex}
          binding={binding}
          bindingIndex={bindingIndex}
          bindingCount={bindingCount}
          recording={recording}
          isAppendSlot={isAppendSlot}
          onStartRecording={onStartRecording}
          onCancelRecording={onCancelRecording}
          onCapture={onCapture}
          onClearError={onClearError}
        />
      </div>
    </div>
  )
}
