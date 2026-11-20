import { useAppMenuPaste } from '@/hooks/clipboard/menu/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/app-commands/useAppMenuSelectionActions'
import { AgentTerminalPreview } from '../dashboard/terminal-preview/AgentTerminalPreview'

export function TerminalPopoutRoot({ ptyId }: { ptyId: string }): React.JSX.Element {
  // The pop-out has no App shell to translate Edit-menu IPC into terminal ownership events.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  return (
    <AgentTerminalPreview
      ptyId={ptyId}
      className="h-screen"
      onRequestClose={() => window.close()}
    />
  )
}
