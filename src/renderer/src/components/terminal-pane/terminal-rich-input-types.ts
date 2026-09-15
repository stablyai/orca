import type { AgentType } from '../../../../shared/agent-status-types'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalTargetShell } from './terminal-drop-shell'
import type { TerminalRichInputSubmitResult } from './terminal-rich-input-submit'

export type TerminalRichInputImageAttachment = {
  id: string
  path: string
  previewSrc?: string
}

export type TerminalRichInputProps = {
  open: boolean
  pane: ManagedPane
  scopeKey: string
  worktreeId: string
  worktreePath: string
  agent: AgentType | null
  connectionId: string | null
  runtimeEnvironmentId: string | null
  targetShell: TerminalTargetShell
  onClose: () => void
  onSubmit: (text: string, imagePaths: string[]) => Promise<TerminalRichInputSubmitResult>
}
