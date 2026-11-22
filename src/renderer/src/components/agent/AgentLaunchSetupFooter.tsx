import { terminalPendingLabel } from './launch-menu/new-tab-agent-menu-model'
import { useImperativeHandle, useRef, type Ref } from 'react'
import { CornerDownLeft, MessageSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import { AgentLaunchPromptComposer } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { formatKeybinding } from '../../../../shared/keybindings/formatting'

export type AgentLaunchSetupFooterHandle = { launch: (surface: AgentPickerSurface) => void }

/** Chat and Terminal split the row. The filled button is the one Enter commits. */
export function AgentLaunchSurfaceButtons({
  entry,
  surfaces = agentPickerButtonOrder(entry),
  verb,
  disabled,
  unavailable,
  primary,
  onSelect
}: {
  entry: AgentPickerEntry
  surfaces?: readonly AgentPickerSurface[]
  verb: 'launch' | 'open'
  disabled?: boolean
  /** Why a surface can't be chosen now; its button is disabled. */
  unavailable?: Partial<Record<AgentPickerSurface, string>>
  primary: AgentPickerSurface
  onSelect: (surface: AgentPickerSurface) => void
}): React.JSX.Element {
  const t = useTranslate()
  const platform = getShortcutPlatform()
  const surfaceIcon = (surface: AgentPickerSurface) =>
    surface === 'chat' ? <MessageSquare /> : <SquareTerminal />
  const surfaceLabel = (surface: AgentPickerSurface) =>
    verb === 'open'
      ? surface === 'chat'
        ? t('agentPicker.openAsChat', 'Open as chat')
        : t('agentPicker.openAsTerminal', 'Open as terminal')
      : surface === 'chat'
        ? t('agentPicker.launchChat', 'Launch chat')
        : t('agentPicker.launchTerminal', 'Launch terminal')
  return (
    <div className="grid w-full max-w-full auto-cols-fr grid-flow-col gap-2">
      {surfaces.map((next) => {
        const isPrimary = next === primary
        const label = surfaceLabel(next)
        const reason = unavailable?.[next]
        return (
          <Button
            key={next}
            type="button"
            size="sm"
            className="min-w-0 w-full"
            aria-label={label}
            aria-keyshortcuts={
              isPrimary ? 'Enter' : platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
            }
            disabled={disabled || reason !== undefined}
            aria-description={reason}
            title={reason}
            variant={isPrimary ? 'default' : 'outline'}
            onClick={() => onSelect(next)}
          >
            {surfaceIcon(next)}
            <span className="mr-auto truncate">{label}</span>
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
  ref,
  disabled,
  terminalBlocked,
  onLaunch
}: {
  entry: AgentPickerEntry
  ref?: Ref<AgentLaunchSetupFooterHandle>
  disabled?: boolean
  terminalBlocked?: boolean
  onLaunch: (surface: AgentPickerSurface, prompt?: string) => boolean | void | Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const composer = useRef<NativeChatComposerHandle>(null)
  // Enter launches the default way; a Launch button names its own before it submits the prompt.
  const surface = useRef(entry.defaultSurface)
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
        className="border-t border-border px-2 pt-2 pb-2"
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
          onLaunch={(prompt) =>
            surface.current === 'terminal' && terminalBlocked
              ? false
              : onLaunch(surface.current, prompt)
          }
        />
      </div>
      <div className="flex items-center px-2 pb-2">
        <AgentLaunchSurfaceButtons
          entry={entry}
          disabled={disabled}
          verb="launch"
          primary={entry.defaultSurface}
          unavailable={terminalBlocked ? { terminal: terminalPendingLabel(t) } : undefined}
          onSelect={launch}
        />
      </div>
    </>
  )
}
