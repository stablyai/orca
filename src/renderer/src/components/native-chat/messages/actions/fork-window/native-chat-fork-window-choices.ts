import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import type {
  ChatForkPath,
  ChatForkSurface
} from '../../../../../../../shared/native-chat/chat-fork-path'

/** Which menu item opened the Fork window; it only picks the window's starting choices. */
export type NativeChatForkWindowPreset = 'tab' | 'worktree' | 'subagent'

/** Where the fork opens: a new tab beside its source, a new worktree, or a workspace that exists. */
export type NativeChatForkWorkspaceChoice =
  | { kind: 'this' }
  | { kind: 'new-worktree' }
  | { kind: 'existing'; worktreeId: string }

export type NativeChatForkRunAs = 'open' | 'subagent'

export type NativeChatForkRoute = ChatForkPath

export type NativeChatForkHostInput = {
  id: ExecutionHostId
  label: string
  /** What the host advertises; null while it is not connected. */
  capabilities: readonly string[] | null
}

export type NativeChatForkHostChoice = {
  id: ExecutionHostId
  label: string
  disabled: boolean
  /** Why a host can't take this fork. */
  blocked?: 'offline'
}

/** Two launch modes of one CLI share its usage limit, so neither can answer for the other. */
function sharesUsageLimit(left: TuiAgent, right: TuiAgent): boolean {
  return TUI_AGENT_CONFIG[left].expectedProcess === TUI_AGENT_CONFIG[right].expectedProcess
}

/** The same agent, unless it is out of usage: then the preferred agent that doesn't share its limit. */
export function defaultNativeChatForkAgent(input: {
  sourceAgent: TuiAgent
  usageLimited: boolean
  available: readonly TuiAgent[]
  preferred?: TuiAgent | null
}): TuiAgent {
  if (!input.usageLimited) {
    return input.sourceAgent
  }
  const others = input.available.filter((agent) => !sharesUsageLimit(agent, input.sourceAgent))
  if (input.preferred && others.includes(input.preferred)) {
    return input.preferred
  }
  return others[0] ?? input.sourceAgent
}

/** The person's agent while the host has it, or until detection answers; else the default. The
 *  choice is settled once the host has answered for any agent other than the chat's own. */
export function nativeChatForkAgent(input: {
  picked: TuiAgent | null
  sourceAgent: TuiAgent
  usageLimited: boolean
  available: readonly TuiAgent[]
  preferred?: TuiAgent | null
  detecting: boolean
}): { agent: TuiAgent; settled: boolean } {
  const { picked, detecting } = input
  if (picked && (detecting || input.available.includes(picked))) {
    return { agent: picked, settled: !detecting || picked === input.sourceAgent }
  }
  // At a usage limit the default agent is only known once detection answers.
  return { agent: defaultNativeChatForkAgent(input), settled: !(detecting && input.usageLimited) }
}

/** The source host first, then every other host. A connected host can always take a recap, so
 *  only an offline one is blocked; one that can't import an exact copy gets a recap instead. */
export function nativeChatForkHostChoices(input: {
  sourceHostId: ExecutionHostId
  hosts: readonly NativeChatForkHostInput[]
}): NativeChatForkHostChoice[] {
  const source = input.hosts.find((host) => host.id === input.sourceHostId)
  const choice = (host: NativeChatForkHostInput | undefined, id: ExecutionHostId) => ({
    id,
    label: host?.label ?? id,
    ...(host?.capabilities ? { disabled: false } : { disabled: true, blocked: 'offline' as const })
  })
  return [
    choice(source, input.sourceHostId),
    ...input.hosts
      .filter((host) => host.id !== input.sourceHostId)
      .map((host) => choice(host, host.id))
  ]
}

/** The kinds the fork can open as: the chat's own kind with the same agent on its host, else a chat
 *  where the target opens the agent as one and a terminal where its CLI was found; unknown is allowed,
 *  and the launch itself says when the agent isn't there. */
export function nativeChatForkSurfaces(input: {
  sourceSurface: ChatForkSurface
  sameHost: boolean
  sameAgent: boolean
  agent: TuiAgent
  chatAgents: readonly TuiAgent[] | null
  cliAgents: readonly TuiAgent[] | null
}): Record<ChatForkSurface, boolean> {
  const own = input.sameHost && input.sameAgent
  return {
    chat:
      (own && input.sourceSurface === 'chat') ||
      input.chatAgents === null ||
      input.chatAgents.includes(input.agent),
    terminal:
      (own && input.sourceSurface === 'terminal') ||
      input.cliAgents === null ||
      input.cliAgents.includes(input.agent)
  }
}

/** The starting workspace and run mode for the menu item that opened the window. */
export function nativeChatForkWindowStart(
  preset: NativeChatForkWindowPreset,
  newWorktreeOffered: boolean
): { workspace: NativeChatForkWorkspaceChoice; runAs: NativeChatForkRunAs } {
  if (preset === 'tab' || !newWorktreeOffered) {
    return { workspace: { kind: 'this' }, runAs: 'open' }
  }
  return { workspace: { kind: 'new-worktree' }, runAs: preset === 'subagent' ? 'subagent' : 'open' }
}

/** A background subagent copies the exact history on its own host into a workspace of its own. */
export function nativeChatForkSubagentAllowed(input: {
  route: NativeChatForkRoute
  subagentOffered: boolean
  workspace: NativeChatForkWorkspaceChoice
}): boolean {
  return input.route === 'same' && input.subagentOffered && input.workspace.kind !== 'this'
}

/** The workspace choices a route allows: another host only has the workspaces already there. */
export function nativeChatForkWorkspaceKinds(input: {
  sameHost: boolean
  route: NativeChatForkRoute
  newWorktreeOffered: boolean
  destinationOffered: boolean
}): NativeChatForkWorkspaceChoice['kind'][] {
  if (!input.sameHost) {
    return ['existing']
  }
  const anotherWorkspace = input.route !== 'same' || input.destinationOffered
  return [
    'this',
    ...(input.newWorktreeOffered ? (['new-worktree'] as const) : []),
    ...(anotherWorkspace ? (['existing'] as const) : [])
  ]
}
