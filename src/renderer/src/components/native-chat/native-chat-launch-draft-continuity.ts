import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  launchDraftSources,
  associateLaunchDraftContext,
  nativeChatLaunchPromptDraftOwner,
  type LaunchDraftSource
} from './native-chat-launch-draft-source'
import { transitionLaunchDrafts } from './native-chat-launch-draft-transition'

const claims = new WeakMap<SshRepoReadoption, ReadonlyMap<string, ReadonlySet<LaunchDraftSource>>>()
/** Bind once at the actual accepted workspace publication, before a new repo row is required. */
export function continueReadoptedLaunchDrafts(readoptions: readonly SshRepoReadoption[]): void {
  if (!readoptions.length) {
    return
  }
  const routes = new Map<string, SshRepoReadoption>()
  const captured = new Map<SshRepoReadoption, Map<string, Set<LaunchDraftSource>>>()
  const continued = new Set<string>()
  const sources = [...launchDraftSources()]
  for (const source of sources) {
    for (const handle of source.handles.values()) {
      const owner = nativeChatLaunchPromptDraftOwner(handle.initialScope)
      if (owner && owner.executionHostId !== source.executionHostId) {
        continued.add(
          JSON.stringify([owner.executionHostId, getRepoIdFromWorktreeId(owner.workspaceId)])
        )
      }
    }
  }
  for (const event of readoptions) {
    if (event.oldTargetId === event.newTargetId) {
      continue
    }
    const repositories = new Map<string, Set<LaunchDraftSource>>()
    captured.set(event, repositories)
    for (const repoId of event.repoIds) {
      if (claims.get(event)?.has(repoId)) {
        continue
      }
      repositories.set(repoId, new Set())
      const key = JSON.stringify([`ssh:${event.oldTargetId}`, repoId])
      if (!continued.has(key)) {
        routes.set(key, event)
      }
    }
  }
  const destinations = new Map<LaunchDraftSource, ExecutionHostId>()
  for (const source of sources) {
    const repo = getRepoIdFromWorktreeId(source.workspaceId)
    let host = source.executionHostId
    const visited = new Set<string>()
    let event = routes.get(JSON.stringify([host, repo]))
    while (event && !visited.has(host)) {
      visited.add(host)
      captured.get(event)?.get(repo)?.add(source)
      associateLaunchDraftContext(source, host)
      host = toSshExecutionHostId(event.newTargetId)
      event = routes.get(JSON.stringify([host, repo]))
    }
    if (host !== source.executionHostId) {
      destinations.set(source, host)
    }
  }
  for (const [event, repositories] of captured) {
    claims.set(event, new Map([...(claims.get(event) ?? []), ...repositories]))
  }
  transitionLaunchDrafts((source) => {
    const executionHostId = destinations.get(source)
    return executionHostId ? { workspaceId: source.workspaceId, executionHostId } : undefined
  })
}
/** Pending subsets and merged descriptors keep the already-applied source identity. */
export function inheritLaunchReadoptions(
  previous: readonly SshRepoReadoption[],
  next: readonly SshRepoReadoption[]
): void {
  const byRoute = new Map<string, Map<string, Set<LaunchDraftSource>>>()
  for (const event of previous) {
    const held = claims.get(event)
    if (!held) {
      continue
    }
    const key = JSON.stringify([event.oldTargetId, event.newTargetId])
    const repositories = byRoute.get(key) ?? new Map<string, Set<LaunchDraftSource>>()
    for (const [repo, heldSources] of held) {
      const sources = repositories.get(repo) ?? new Set<LaunchDraftSource>()
      for (const source of heldSources) {
        sources.add(source)
      }
      repositories.set(repo, sources)
    }
    byRoute.set(key, repositories)
  }
  for (const event of next) {
    const repositories = byRoute.get(JSON.stringify([event.oldTargetId, event.newTargetId]))
    if (repositories) {
      claims.set(
        event,
        new Map(
          event.repoIds.flatMap((repo) => {
            const held = repositories.get(repo)
            return held ? [[repo, held] as const] : []
          })
        )
      )
    }
  }
}

/** Takes the fetched host catalog: its folders are that payload, not a store record read. */
export function continueFolderLaunchDrafts({
  hostId: origin,
  folderWorkspaces: folders
}: {
  hostId: string
  folderWorkspaces: readonly FolderWorkspace[]
}): void {
  const owners = new Map<string, ExecutionHostId | null>()
  for (const folder of folders) {
    const host = folder.executionHostId
    if (host) {
      owners.set(`folder:${folder.id}`, owners.has(`folder:${folder.id}`) ? null : host)
    }
  }
  transitionLaunchDrafts((source) => {
    const executionHostId = source.origin === origin && owners.get(source.workspaceId)
    return executionHostId ? { workspaceId: source.workspaceId, executionHostId } : undefined
  })
}
