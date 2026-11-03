import { useImperativeHandle, useRef, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { NativeChatComposerHandle } from '../native-chat/NativeChatComposer'
import { AgentLaunchPromptComposer } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type agentPickerEntryOptions,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'
import { formatKeybinding } from '../../../../shared/keybindings'

export function agentLaunchSetupArgumentsNote(
  label: string,
  options: ReturnType<typeof agentPickerEntryOptions>,
  noModelFlag: boolean
) {
  const composed = options.some((option) => option.apply.composedIntoModel)
  const noOptionFlag = options.some(
    (option) => !option.apply.cli?.length && !option.apply.composedIntoModel
  )
  return noModelFlag || noOptionFlag
    ? translate(
        'agentPicker.chatChoicesNote',
        '{{agent}} model or effort choices without a CLI flag apply to chats.',
        { agent: label }
      )
    : composed
      ? translate(
          'agentPicker.composedChoicesNote',
          '{{agent}} effort and speed choices are included in the model argument.',
          { agent: label }
        )
      : undefined
}

export type AgentLaunchSetupFooterHandle = { launch: (surface: AgentPickerSurface) => void }

/** Chat and Terminal live on the setup popover. The filled button is the one Enter commits. */
export function AgentLaunchSurfaceButtons({
  entry,
  disabled,
  primary,
  onSelect
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  primary: AgentPickerSurface
  onSelect: (surface: AgentPickerSurface) => void
}): React.JSX.Element {
  const platform = getShortcutPlatform()
  return (
    <div className="grid max-w-full auto-cols-fr grid-flow-col gap-2">
      {agentPickerButtonOrder(entry).map((next) => {
        const isPrimary = next === primary
        const label =
          next === 'chat'
            ? translate('agentPicker.launchChat', 'Launch chat')
            : translate('agentPicker.launchTerminal', 'Launch terminal')
        return (
          <Button
            key={next}
            type="button"
            size="xs"
            className="min-w-0 w-full"
            aria-label={label}
            aria-keyshortcuts={
              isPrimary ? 'Enter' : platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
            }
            disabled={disabled}
            variant={isPrimary ? 'default' : 'outline'}
            onClick={() => onSelect(next)}
          >
            <span className="truncate">{label}</span>
            <span aria-hidden="true">
              <ShortcutKeyCombo
                keys={formatKeybinding(isPrimary ? 'Enter' : 'Mod+Enter', platform)}
                className="gap-0.5 opacity-60"
                keyCapClassName="min-w-0 border-0 bg-transparent p-0 text-2xs text-current shadow-none"
                separatorClassName="text-2xs text-current"
              />
            </span>
          </Button>
        )
      })}
    </div>
  )
}

/** The optional first prompt and the Launch buttons, which send whatever it holds. */
export function AgentLaunchSetupFooter({
  entry,
  ref,
  disabled,
  onLaunch
}: {
  entry: AgentPickerEntry
  ref?: Ref<AgentLaunchSetupFooterHandle>
  disabled?: boolean
  onLaunch: (surface: AgentPickerSurface, prompt?: string) => boolean | void | Promise<boolean>
}): React.JSX.Element {
  const composer = useRef<NativeChatComposerHandle>(null)
  // Enter launches the default way; a Launch button names its own before it submits the prompt.
  const surface = useRef(entry.defaultSurface)
  const launch = (next: AgentPickerSurface): void => {
    // The composer resolves pastes and pending files, then hands the text to onLaunch.
    surface.current = next
    composer.current?.submit?.()
  }
  useImperativeHandle(ref, () => ({ launch }))
  return (
    <>
      <div
        className="px-3 pt-1.5 pb-2"
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter') {
            surface.current = entry.defaultSurface
          }
        }}
      >
        <AgentLaunchPromptComposer
          entry={entry}
          composerRef={composer}
          disabled={disabled}
          onLaunch={(prompt) => onLaunch(surface.current, prompt)}
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-2">
        <AgentLaunchSurfaceButtons
          entry={entry}
          disabled={disabled}
          primary={entry.defaultSurface}
          onSelect={launch}
        />
      </div>
    </>
  )
}
