// Where the sidebar lists what is in front: a Projects row, a Bots row, or no row (and why).
// Derived on demand from state that already exists; nothing here is stored.
import type { ExecutionHostId } from '../execution-host/execution-host'
import { getRepoExecutionHostId } from '../execution-host/execution-host'
import { getFolderWorkspaceChildWorktrees } from '../folder-workspace-child-worktrees'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../workspace/identity/workspace-scope'

export type SidebarRevealNoneReason =
  | 'no-workspace'
  | 'full-page-view'
  | 'archived'
  | 'bots-off'
  | 'bot-hidden'

type WorkerRef = Pick<Worktree, 'id' | 'hostId'>

export type SidebarBotsRevealTarget = {
  section: 'bots'
  /** The bot's or group's row, `hostId/id`. */
  entryKey: string
  /** The bot chat whose tab is in front. */
  chatId?: string
  /** The active workspace is one of the bot's worker lines; `ancestors` are the lines above it, root first. */
  worker?: {
    id: string
    hostId: ExecutionHostId | null
    /** The line's host identity, as its row is keyed. */
    identity: string
    ancestors: readonly WorkerRef[]
  }
  /** The owner's host is down: its row lists nothing under it, so the row is as deep as it goes. */
  hostDown: boolean
}

export type SidebarRevealTarget =
  | { section: 'projects'; worktreeId: string; executionHostId: ExecutionHostId | null }
  | SidebarBotsRevealTarget
  | { section: 'none'; reason: SidebarRevealNoneReason }

/** A bot's or a group's row in the Bots section, with its home. */
export type SidebarRevealOwner = {
  kind: 'bot' | 'group'
  entryKey: string
  home: Pick<FolderWorkspace, 'id' | 'connectionId' | 'executionHostId'>
  /** Left out of the list by Bot options (paused and hidden). */
  hidden: boolean
  hostDown: boolean
}

/** The bot row a worker line sits under, and the lines between them. */
export type BotWorkerOwnership = { entryKey: string; ancestors: readonly WorkerRef[] }

/** Each worker line's bot, by host identity, over the bots' homes and the sidebar's lineage;
 *  nested workers (a worker's own children) included. Groups list no workers. */
export function buildBotWorkerOwners(
  owners: readonly SidebarRevealOwner[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
): ReadonlyMap<string, BotWorkerOwnership> {
  const result = new Map<string, BotWorkerOwnership>()
  for (const owner of owners) {
    if (owner.kind !== 'bot') {
      continue
    }
    const { childWorktrees, lineageChildrenByParentIdentity } = getFolderWorkspaceChildWorktrees(
      getFolderWorkspaceHostIdentity(owner.home),
      childrenByParentIdentity
    )
    const queue: { line: Worktree; ancestors: readonly WorkerRef[] }[] = childWorktrees.map(
      (line) => ({ line, ancestors: [] })
    )
    for (let index = 0; index < queue.length; index += 1) {
      const { line, ancestors } = queue[index]!
      const identity = getWorktreeHostIdentity(line)
      // The sidebar nests each workspace under one parent; a repeat is a cycle, not a second owner.
      if (result.has(identity)) {
        continue
      }
      result.set(identity, { entryKey: owner.entryKey, ancestors })
      const below = [...ancestors, { id: line.id, hostId: line.hostId }]
      for (const child of lineageChildrenByParentIdentity.get(identity) ?? []) {
        queue.push({ line: child, ancestors: below })
      }
    }
  }
  return result
}

export type SidebarWorkspaceOwnerInputs = {
  botsEnabled: boolean
  /** Hide bot workspaces: on, the Bots section is a worker's only listing. */
  hideBotCreatedWorkspaces: boolean
  owners: readonly SidebarRevealOwner[]
  workerOwners: ReadonlyMap<string, BotWorkerOwnership>
}

export type SidebarWorkspaceOwner =
  | { section: 'projects' }
  | Omit<SidebarBotsRevealTarget, 'chatId'>
  | { section: 'none'; reason: 'bots-off' | 'bot-hidden' }

function ownerOfHome(
  owners: readonly SidebarRevealOwner[],
  workspaceId: string,
  hostId: ExecutionHostId | null
): SidebarRevealOwner | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type !== 'folder') {
    return null
  }
  return (
    owners.find(
      (owner) =>
        owner.home.id === scope.folderWorkspaceId &&
        (!hostId || getRepoExecutionHostId(owner.home) === hostId)
    ) ?? null
  )
}

function ownerOfWorker(
  workerOwners: ReadonlyMap<string, BotWorkerOwnership>,
  workspaceId: string,
  hostId: ExecutionHostId | null
): (BotWorkerOwnership & { identity: string }) | null {
  if (hostId) {
    const identity = composeWorktreeHostIdentity(hostId, workspaceId)
    const ownership = workerOwners.get(identity)
    return ownership ? { ...ownership, identity } : null
  }
  // No host named: only an unambiguous match counts, so a same-id twin on another host never wins.
  let found: (BotWorkerOwnership & { identity: string }) | null = null
  for (const [identity, ownership] of workerOwners) {
    if (getWorktreeIdFromHostIdentity(identity) === workspaceId) {
      if (found) {
        return null
      }
      found = { ...ownership, identity }
    }
  }
  return found
}

/** Which section lists a workspace: Bots for a bot's or group's home and for a bot's worker lines
 *  while Hide bot workspaces is on; Projects otherwise. */
export function resolveSidebarWorkspaceOwner(
  input: SidebarWorkspaceOwnerInputs,
  workspaceId: string,
  hostId: ExecutionHostId | null
): SidebarWorkspaceOwner {
  const home = ownerOfHome(input.owners, workspaceId, hostId)
  if (home) {
    if (!input.botsEnabled) {
      return { section: 'none', reason: 'bots-off' }
    }
    if (home.hidden) {
      return { section: 'none', reason: 'bot-hidden' }
    }
    return { section: 'bots', entryKey: home.entryKey, hostDown: home.hostDown }
  }
  // Bots off or Hide bot workspaces off: the worker's project lists it, as any workspace.
  if (!input.botsEnabled || !input.hideBotCreatedWorkspaces) {
    return { section: 'projects' }
  }
  const worker = ownerOfWorker(input.workerOwners, workspaceId, hostId)
  if (!worker) {
    return { section: 'projects' }
  }
  const owner = input.owners.find((candidate) => candidate.entryKey === worker.entryKey)
  if (!owner || owner.hidden) {
    return { section: 'none', reason: 'bot-hidden' }
  }
  return {
    section: 'bots',
    entryKey: owner.entryKey,
    worker: { id: workspaceId, hostId, identity: worker.identity, ancestors: worker.ancestors },
    hostDown: owner.hostDown
  }
}

export type SidebarRevealTargetInputs = SidebarWorkspaceOwnerInputs & {
  activeView: string
  /** The open workspace's sidebar id (`getActiveSidebarWorkspaceId`). */
  activeWorkspaceId: string | null
  activeHostId: ExecutionHostId | null
  frontTab: { contentType: string; entityId?: string | null } | null
  /** The open workspace is archived. */
  activeIsArchived: boolean
}

/** What "Reveal current" points at, in order: the view, the workspace, its owner, its front tab. */
export function resolveSidebarRevealTarget(input: SidebarRevealTargetInputs): SidebarRevealTarget {
  if (input.activeView !== 'terminal') {
    return { section: 'none', reason: 'full-page-view' }
  }
  const workspaceId = input.activeWorkspaceId
  if (!workspaceId) {
    return { section: 'none', reason: 'no-workspace' }
  }
  const owner = resolveSidebarWorkspaceOwner(input, workspaceId, input.activeHostId)
  if (owner.section === 'none') {
    return owner
  }
  if (input.activeIsArchived) {
    return { section: 'none', reason: 'archived' }
  }
  if (owner.section === 'projects') {
    return { section: 'projects', worktreeId: workspaceId, executionHostId: input.activeHostId }
  }
  const tab = input.frontTab
  // A bot's chat is a tab of its home; a group's rooms are its own row.
  const chatId =
    !owner.worker &&
    tab?.contentType === 'agent-session' &&
    tab.entityId &&
    input.owners.find((candidate) => candidate.entryKey === owner.entryKey)?.kind === 'bot'
      ? tab.entityId
      : undefined
  return chatId ? { ...owner, chatId } : owner
}

/** A bot's worker line's own row key, by host identity: a rename names it, so the same worktree's
 *  card elsewhere at once (Send to agent's Projects row, a same-id twin on another host) stays put. */
export function botWorkerLineRowKey(identity: string): string {
  return `bot-line:${identity}`
}

/** A stable string for a target, to tell whether what is in front moved. */
export function sidebarRevealTargetKey(target: SidebarRevealTarget): string {
  switch (target.section) {
    case 'projects':
      return `projects:${target.executionHostId ?? ''}:${target.worktreeId}`
    case 'none':
      return `none:${target.reason}`
    case 'bots':
      return `bots:${target.entryKey}:${target.chatId ?? ''}:${target.worker ? `${target.worker.hostId ?? ''}|${target.worker.id}` : ''}:${target.hostDown ? 'down' : 'up'}`
  }
}
