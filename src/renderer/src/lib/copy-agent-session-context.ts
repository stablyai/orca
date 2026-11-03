import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { buildBoundedSessionTranscript } from './agent-session-fork-context'

export async function copyAgentSessionContext(
  capturedText: string,
  focusSource: () => void,
  emptyMessage: string
): Promise<boolean> {
  const transcript = buildBoundedSessionTranscript(capturedText)
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
