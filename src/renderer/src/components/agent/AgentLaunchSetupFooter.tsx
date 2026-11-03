import { useImperativeHandle, useRef, type Ref } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { NativeChatComposerHandle } from '../native-chat/NativeChatComposer'
import { AgentLaunchPromptComposer } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'
import { formatKeybinding } from '../../../../shared/keybindings'

export type AgentLaunchSetupFooterHandle = { launch: (surface: AgentPickerSurface) => void }

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
  const platform = getShortcutPlatform()
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
        <div className="grid max-w-full auto-cols-fr grid-flow-col gap-2">
          {agentPickerButtonOrder(entry).map((next) => {
            const primary = next === entry.defaultSurface
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
                  primary ? 'Enter' : platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
                }
                disabled={disabled}
                variant={primary ? 'default' : 'outline'}
                onClick={() => launch(next)}
              >
                <span className="truncate">{label}</span>
                <span aria-hidden="true">
                  <ShortcutKeyCombo
                    keys={formatKeybinding(primary ? 'Enter' : 'Mod+Enter', platform)}
                    renderKey={(key) =>
                      key === 'Enter' ? <CornerDownLeft className="size-3" /> : key
                    }
                    className="gap-0.5 opacity-60"
                    keyCapClassName="min-w-0 border-0 bg-transparent p-0 text-2xs text-current shadow-none"
                    separatorClassName="text-2xs text-current"
                  />
                </span>
              </Button>
            )
          })}
        </div>
      </div>
    </>
  )
}
