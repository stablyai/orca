import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'

/** Which menu item opened the Fork window; it only picks the window's starting choices. */
export type NativeChatForkWindowPreset = 'tab' | 'worktree' | 'subagent'

/** Where the fork opens: a new tab beside its source, a new worktree, or a workspace that exists. */
export type NativeChatForkWorkspaceChoice =
  | { kind: 'this' }
  | { kind: 'new-worktree' }
  | { kind: 'existing'; worktreeId: string }

export type NativeChatForkRunAs = 'open' | 'subagent'

/** How a fork travels: the exact history on its host, the exact history copied to another host,
 *  or a recap of the history handed to another agent. */
export type NativeChatForkRoute = 'same' | 'other-host' | 'recap'

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
  blocked?: 'offline' | 'needs-update'
}

export function nativeChatForkRoute(input: {
  sourceHostId: ExecutionHostId
  hostId: ExecutionHostId
  sourceAgent: TuiAgent
  agent: TuiAgent
}): NativeChatForkRoute {
  if (input.agent !== input.sourceAgent) {
    return 'recap'
  }
  return input.hostId === input.sourceHostId ? 'same' : 'other-host'
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

/** The source host first, then the hosts this fork can reach. Copying the exact history needs the
 *  source to export it and the target to import it; a recap only needs a connected host. */
export function nativeChatForkHostChoices(input: {
  sourceHostId: ExecutionHostId
  hosts: readonly NativeChatForkHostInput[]
  copiesHistory: boolean
  sourceCanExport: boolean
  importCapability: string
}): NativeChatForkHostChoice[] {
  const source = input.hosts.find((host) => host.id === input.sourceHostId)
  const first: NativeChatForkHostChoice = {
    id: input.sourceHostId,
    label: source?.label ?? input.sourceHostId,
    disabled: false
  }
  if (input.copiesHistory && !input.sourceCanExport) {
    return [first]
  }
  const others = input.hosts
    .filter((host) => host.id !== input.sourceHostId)
    .map((host): NativeChatForkHostChoice => {
      if (host.capabilities === null) {
        return { id: host.id, label: host.label, disabled: true, blocked: 'offline' }
      }
      if (input.copiesHistory && !host.capabilities.includes(input.importCapability)) {
        return { id: host.id, label: host.label, disabled: true, blocked: 'needs-update' }
      }
      return { id: host.id, label: host.label, disabled: false }
    })
  return [first, ...others]
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
  const anotherWorkspace = input.route === 'recap' || input.destinationOffered
  return [
    'this',
    ...(input.newWorktreeOffered ? (['new-worktree'] as const) : []),
    ...(anotherWorkspace ? (['existing'] as const) : [])
  ]
}

/** The messages a recap describes: everything up to the fork point, its whole turn included. */
export function nativeChatForkRecapMessages(
  messages: readonly NativeChatMessage[],
  throughItemId: string
): readonly NativeChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === throughItemId)
  if (index === -1) {
    return null
  }
  let end = index + 1
  while (end < messages.length && messages[end]?.role !== 'user') {
    end += 1
  }
  return messages.slice(0, end)
}
