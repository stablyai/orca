import { useRef } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerHandle } from '../native-chat/NativeChatComposer'
import { readNativeChatComposerDraft } from '../native-chat/native-chat-composer-draft-store'
import { AgentLaunchPromptComposer, agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

/** The optional first prompt and the Launch buttons, which send whatever it holds. */
export function AgentLaunchSetupFooter({
  entry,
  disabled,
  onLaunch
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  onLaunch: (surface: AgentPickerSurface, prompt?: string) => void
}): React.JSX.Element {
  const composer = useRef<NativeChatComposerHandle>(null)
  // Enter launches the default way; a Launch button names its own before it submits the prompt.
  const surface = useRef(entry.defaultSurface)
  const launch = (next: AgentPickerSurface): void => {
    const typed = readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry))
    if (typed.text.trim() === '' && typed.images.length === 0) {
      onLaunch(next)
      return
    }
    // The composer resolves pastes and pending files, then hands the text to onLaunch.
    surface.current = next
    composer.current?.submit?.()
  }
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
