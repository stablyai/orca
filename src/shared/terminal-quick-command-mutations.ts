import {
  getTerminalQuickCommandAction,
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand,
  isTerminalQuickCommandComplete,
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_ID_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH,
  supportsTerminalAgentQuickCommand
} from './terminal-quick-commands'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandAction,
  TerminalQuickCommandScope
} from './terminal-quick-command-types'

// Why: `applicable` is what a workspace actually shows — global plus that repo.
export type TerminalQuickCommandScopeFilter = 'all' | 'global' | 'repo' | 'applicable'

export type TerminalQuickCommandCreateInput = {
  id?: string
  label: string
  scope?: TerminalQuickCommandScope
  action?: TerminalQuickCommandAction
  command?: string
  appendEnter?: boolean
  agent?: string
  prompt?: string
}

export type TerminalQuickCommandUpdateInput = Omit<TerminalQuickCommandCreateInput, 'id' | 'label'> &
  Partial<Pick<TerminalQuickCommandCreateInput, 'label'>>

type TerminalQuickCommandBodyInput = Pick<
  TerminalQuickCommandCreateInput,
  'command' | 'appendEnter' | 'agent' | 'prompt'
>

export function findTerminalQuickCommand(
  commands: readonly TerminalQuickCommand[],
  id: string
): TerminalQuickCommand | null {
  return commands.find((command) => command.id === id) ?? null
}

export function filterTerminalQuickCommandsByScope(
  commands: readonly TerminalQuickCommand[],
  scope: TerminalQuickCommandScope
): TerminalQuickCommand[] {
  return commands.filter((command) => {
    const commandScope = command.scope ?? { type: 'global' }
    if (scope.type === 'global') {
      return commandScope.type === 'global'
    }
    return commandScope.type === 'repo' && commandScope.repoId === scope.repoId
  })
}

// Why: the resolved action decides which body fields are read, so a field
// belonging to the other action would be dropped without a word — fail instead.
function assertBodyMatchesAction(
  action: TerminalQuickCommandAction,
  input: TerminalQuickCommandBodyInput
): void {
  const stray =
    action === 'agent-prompt'
      ? input.command !== undefined || input.appendEnter !== undefined
      : input.prompt !== undefined || input.agent !== undefined
  if (stray) {
    throw new Error('quick_command_body_action_mismatch')
  }
}

// Why: normalization truncates instead of rejecting, and a clipped command is
// still submitted to a terminal — so cap-busting input must not reach it.
function assertWithinLimits(command: TerminalQuickCommand): TerminalQuickCommand {
  if (command.id.length > MAX_QUICK_COMMAND_ID_LENGTH) {
    throw new Error('quick_command_id_too_long')
  }
  if (command.label.length > MAX_QUICK_COMMAND_LABEL_LENGTH) {
    throw new Error('quick_command_label_too_long')
  }
  const bodyLimit = isTerminalAgentQuickCommand(command)
    ? MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
    : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
  if (getTerminalQuickCommandBody(command).length > bodyLimit) {
    throw new Error('quick_command_body_too_long')
  }
  return command
}

function assertComplete(command: TerminalQuickCommand): TerminalQuickCommand {
  if (!isTerminalQuickCommandComplete(command)) {
    throw new Error(
      command.label.trim().length === 0
        ? 'quick_command_label_required'
        : 'quick_command_body_required'
    )
  }
  return command
}

function buildCommand(
  id: string,
  label: string,
  scope: TerminalQuickCommandScope,
  action: TerminalQuickCommandAction,
  body: TerminalQuickCommandBodyInput
): TerminalQuickCommand {
  if (action === 'agent-prompt') {
    if (!supportsTerminalAgentQuickCommand(body.agent)) {
      throw new Error(
        body.agent === undefined
          ? 'quick_command_agent_required'
          : 'quick_command_agent_unsupported'
      )
    }
    return { id, label, scope, action: 'agent-prompt', agent: body.agent, prompt: body.prompt ?? '' }
  }
  return {
    id,
    label,
    scope,
    action: 'terminal-command',
    command: body.command ?? '',
    appendEnter: body.appendEnter !== false
  }
}

function validated(
  id: string,
  label: string,
  scope: TerminalQuickCommandScope,
  action: TerminalQuickCommandAction,
  body: TerminalQuickCommandBodyInput
): TerminalQuickCommand {
  return assertComplete(assertWithinLimits(buildCommand(id, label.trim(), scope, action, body)))
}

export function buildTerminalQuickCommandCreate(
  input: TerminalQuickCommandCreateInput,
  createId: () => string
): TerminalQuickCommand {
  const id = input.id?.trim() || createId()
  const action = input.action ?? (input.agent ? 'agent-prompt' : 'terminal-command')
  assertBodyMatchesAction(action, input)
  return validated(id, input.label, input.scope ?? { type: 'global' }, action, input)
}

export function buildTerminalQuickCommandUpdate(
  current: TerminalQuickCommand,
  patch: TerminalQuickCommandUpdateInput
): TerminalQuickCommand {
  const action = patch.action ?? getTerminalQuickCommandAction(current)
  assertBodyMatchesAction(action, patch)
  // Why: switching action carries the old body across so an agent-prompt can be
  // demoted to a shell command (and back) without retyping it.
  const carriedBody = getTerminalQuickCommandBody(current)
  return validated(
    current.id,
    patch.label ?? current.label,
    patch.scope ?? current.scope ?? { type: 'global' },
    action,
    {
      command: patch.command ?? carriedBody,
      appendEnter:
        patch.appendEnter ?? (isTerminalAgentQuickCommand(current) ? true : current.appendEnter),
      agent: patch.agent ?? (isTerminalAgentQuickCommand(current) ? current.agent : undefined),
      prompt: patch.prompt ?? carriedBody
    }
  )
}
