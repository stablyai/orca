import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  buildBoundedSessionTranscript,
  buildFullSessionTranscript
} from './agent-session-fork-context'

type CopyAgentSessionContextOptions = {
  // Pane Copy Context keeps the cleaned scrollback. Native chat stays on the char budget.
  readonly full?: boolean
}

export async function copyAgentSessionContext(
  capturedText: string,
  focusSource: () => void,
  emptyMessage: string,
  options?: CopyAgentSessionContextOptions
): Promise<boolean> {
  const transcript = options?.full
    ? buildFullSessionTranscript(capturedText)
    : buildBoundedSessionTranscript(capturedText)
  if (!transcript) {
    toast.error(emptyMessage)
    focusSource()
    return false
  }
  try {
    await window.api.ui.writeTerminalClipboardText(transcript)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.373a3103e7',
        'Context copied'
      )
    )
    focusSource()
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.3fc568a49d',
            'Failed to copy context.'
          )
    )
    focusSource()
    return false
  }
}
