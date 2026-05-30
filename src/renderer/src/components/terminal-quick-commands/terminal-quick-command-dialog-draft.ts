import {
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import type { TerminalQuickCommand, TuiAgent } from '../../../../shared/types'

export type TerminalQuickCommandDialogAction = 'terminal-command' | 'agent-prompt'

export type TerminalQuickCommandDialogDraftMemory = {
  terminalCommand: string
  terminalAppendEnter: boolean
  agent: TuiAgent
  agentPrompt: string
}

export function createTerminalQuickCommandDialogDraftMemory(
  command: TerminalQuickCommand,
  fallbackAgent: TuiAgent
): TerminalQuickCommandDialogDraftMemory {
  if (isTerminalAgentQuickCommand(command)) {
    return {
      terminalCommand: '',
      terminalAppendEnter: true,
      agent: command.agent,
      agentPrompt: command.prompt
    }
  }
  return {
    terminalCommand: command.command,
    terminalAppendEnter: command.appendEnter,
    agent: fallbackAgent,
    agentPrompt: ''
  }
}

export function rememberTerminalQuickCommandDialogDraft(
  memory: TerminalQuickCommandDialogDraftMemory,
  draft: TerminalQuickCommand
): TerminalQuickCommandDialogDraftMemory {
  if (isTerminalAgentQuickCommand(draft)) {
    return {
      ...memory,
      agent: draft.agent,
      agentPrompt: draft.prompt
    }
  }
  return {
    ...memory,
    terminalCommand: draft.command,
    terminalAppendEnter: draft.appendEnter
  }
}

export function switchTerminalQuickCommandDialogAction(
  draft: TerminalQuickCommand,
  action: TerminalQuickCommandDialogAction,
  memory: TerminalQuickCommandDialogDraftMemory
): {
  draft: TerminalQuickCommand
  memory: TerminalQuickCommandDialogDraftMemory
} {
  const nextMemory = rememberTerminalQuickCommandDialogDraft(memory, draft)
  const base = {
    id: draft.id,
    label: draft.label,
    scope: getTerminalQuickCommandScope(draft)
  }

  // Why: action modes are independent editors; toggling should not transform
  // terminal command text into an agent prompt, or the reverse.
  if (action === 'agent-prompt') {
    return {
      memory: nextMemory,
      draft: {
        ...base,
        action: 'agent-prompt',
        agent: nextMemory.agent,
        prompt: nextMemory.agentPrompt
      }
    }
  }

  return {
    memory: nextMemory,
    draft: {
      ...base,
      action: 'terminal-command',
      command: nextMemory.terminalCommand,
      appendEnter: nextMemory.terminalAppendEnter
    }
  }
}
