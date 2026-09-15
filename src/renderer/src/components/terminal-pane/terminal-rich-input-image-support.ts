import type { AgentType } from '../../../../shared/agent-status-types'
import { getAgentImageHandling } from '../../../../shared/agent-image-handling'
import { formatNativeChatFileReference } from '../native-chat/native-chat-composer-target'
import { shellEscapePath } from './pane-helpers'
import type { TerminalTargetShell } from './terminal-drop-shell'

const IMAGE_FILE_REFERENCE_AGENTS: ReadonlySet<AgentType> = new Set(['opencode', 'kimi', 'pi'])

export function terminalRichInputCanAttachImages(agent: AgentType | null): boolean {
  return (
    !agent ||
    getAgentImageHandling(agent) === 'attachment' ||
    IMAGE_FILE_REFERENCE_AGENTS.has(agent)
  )
}

function terminalRichInputUsesInlineImageText(agent: AgentType | null): boolean {
  return !agent || IMAGE_FILE_REFERENCE_AGENTS.has(agent)
}

export function terminalRichInputInlineImageText(
  agent: AgentType | null,
  imagePath: string,
  targetShell: TerminalTargetShell
): string | null {
  if (!agent) {
    return `${shellEscapePath(imagePath, targetShell)} `
  }
  return IMAGE_FILE_REFERENCE_AGENTS.has(agent)
    ? `${formatNativeChatFileReference(imagePath)} `
    : null
}

export function getTerminalRichInputInlineImageFormatter(
  agent: AgentType | null,
  targetShell: TerminalTargetShell
): ((imagePath: string) => string) | undefined {
  if (!terminalRichInputUsesInlineImageText(agent)) {
    return undefined
  }
  return (imagePath) => terminalRichInputInlineImageText(agent, imagePath, targetShell) ?? ''
}
