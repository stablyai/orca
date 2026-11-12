import { terminalPendingLabel } from '../tab-bar/new-tab-agent-menu-model'
import { useImperativeHandle, useRef, type Ref } from 'react'
import { CornerDownLeft, MessageSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import { AgentLaunchPromptComposer } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { agentPickerEntryOptions } from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { formatKeybinding } from '../../../../shared/keybindings'

export function agentLaunchSetupArgumentsNote(
  label: string,
  options: ReturnType<typeof agentPickerEntryOptions>,
  noModelFlag: boolean,
  t: Translate = translate
) {
  const composed = options.some((option) => option.apply.composedIntoModel)
  const noOptionFlag = options.some(
    (option) => !option.apply.cli?.length && !option.apply.composedIntoModel
  )
  return noModelFlag || noOptionFlag
    ? t(
        'agentPicker.chatChoicesNote',
        '{{agent}} model or effort choices without a CLI flag apply to chats.',
        { agent: label }
      )
    : composed
      ? t(
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
  terminalBlocked,
  primary,
  prominent,
  onSelect
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  terminalBlocked?: boolean
  primary: AgentPickerSurface
  /** Launch is the popover's main action, so its buttons split the full row. */
  prominent?: boolean
  onSelect: (surface: AgentPickerSurface) => void
}): React.JSX.Element {
  const t = useTranslate()
  const platform = getShortcutPlatform()
  const surfaceIcon = (surface: AgentPickerSurface) =>
    surface === 'chat' ? <MessageSquare /> : <SquareTerminal />
  return (
    <div className={cn('grid max-w-full auto-cols-fr grid-flow-col gap-2', prominent && 'w-full')}>
      {agentPickerButtonOrder(entry).map((next) => {
        const isPrimary = next === primary
        const label =
          next === 'chat'
            ? t('agentPicker.launchChat', 'Launch chat')
            : t('agentPicker.launchTerminal', 'Launch terminal')
        return (
          <Button
            key={next}
            type="button"
            size={prominent ? 'sm' : 'xs'}
            className="min-w-0 w-full"
            aria-label={label}
            aria-keyshortcuts={
              isPrimary ? 'Enter' : platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
            }
            disabled={disabled || (next === 'terminal' && terminalBlocked)}
            aria-description={
              next === 'terminal' && terminalBlocked ? terminalPendingLabel(t) : undefined
            }
            title={next === 'terminal' && terminalBlocked ? terminalPendingLabel(t) : undefined}
            variant={isPrimary ? 'default' : 'outline'}
            onClick={() => onSelect(next)}
          >
            {prominent ? surfaceIcon(next) : null}
            <span className={cn('truncate', prominent && 'mr-auto')}>{label}</span>
            <span aria-hidden="true">
              <ShortcutKeyCombo
                keys={formatKeybinding(isPrimary ? 'Enter' : 'Mod+Enter', platform)}
                renderKey={(key) => (key === 'Enter' ? <CornerDownLeft className="size-3" /> : key)}
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
  primary,
  ref,
  disabled,
  terminalBlocked,
  onLaunch
}: {
  entry: AgentPickerEntry
  primary: AgentPickerSurface
  ref?: Ref<AgentLaunchSetupFooterHandle>
  disabled?: boolean
  terminalBlocked?: boolean
  onLaunch: (surface: AgentPickerSurface, prompt?: string) => boolean | void | Promise<boolean>
}): React.JSX.Element {
  const composer = useRef<NativeChatComposerHandle>(null)
  // Enter launches the default way; a Launch button names its own before it submits the prompt.
  const surface = useRef(primary)
  const launch = (next: AgentPickerSurface): void => {
    if (disabled || (next === 'terminal' && terminalBlocked)) {
      return
    }
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
            surface.current = primary
          }
        }}
      >
        <AgentLaunchPromptComposer
          entry={entry}
          composerRef={composer}
          disabled={disabled}
          onLaunch={(prompt) =>
            surface.current === 'terminal' && terminalBlocked
              ? false
              : onLaunch(surface.current, prompt)
          }
        />
      </div>
      <div className="flex items-center px-3 pb-3">
        <AgentLaunchSurfaceButtons
          entry={entry}
          disabled={disabled}
          primary={primary}
          prominent
          terminalBlocked={terminalBlocked}
          onSelect={launch}
        />
      </div>
    </>
  )
}
