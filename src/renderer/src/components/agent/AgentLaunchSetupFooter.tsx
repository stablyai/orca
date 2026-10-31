import { useImperativeHandle, useRef, type Ref } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerHandle } from '../native-chat/NativeChatComposer'
import { AgentLaunchPromptComposer } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

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
  onLaunch: (surface: AgentPickerSurface, prompt?: string) => boolean | void
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
        {agentPickerButtonOrder(entry).map((next) => (
          <Button
            key={next}
            type="button"
            size="xs"
            disabled={disabled}
            variant={next === entry.defaultSurface ? 'default' : 'outline'}
            onClick={() => launch(next)}
          >
            {next === 'chat'
              ? translate('agentPicker.launchChat', 'Launch chat')
              : translate('agentPicker.launchTerminal', 'Launch terminal')}
            {next === entry.defaultSurface ? (
              <CornerDownLeft className="size-3 opacity-60" />
            ) : null}
          </Button>
        ))}
      </div>
    </>
  )
}
