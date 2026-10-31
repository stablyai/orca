import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'

type SetupHandle = { scopeKey: string; active: boolean; readonly initialScope: string }
export type LaunchDraftSource = NativeChatComposerDraftOwner & {
  scopeKey: string
  agent: string
  origin: string
  options?: AgentPickerDraft
  optionListeners: Set<() => void>
  references: Map<string, string>
  handles: Map<string, SetupHandle>
}
const handles = new Map<string, LaunchDraftSource>()
const setups = new Map<string, LaunchDraftSource>()
const pendingHosts = new Map<string, ExecutionHostId>()
/** Derived from the existing accepted pending catalog application, never a request-start inventory. */
export function setPendingLaunchReadoptions(events: readonly SshRepoReadoption[]): void {
  const routes = new Map<string, ExecutionHostId>()
  for (const event of events) {
    for (const repo of event.repoIds) {
      routes.set(
        JSON.stringify([`ssh:${event.oldTargetId}`, repo]),
        toSshExecutionHostId(event.newTargetId)
      )
    }
  }
  pendingHosts.clear()
  for (const [key, host] of routes) {
    if (pendingHosts.has(key)) {
      continue
    }
    const repo = JSON.parse(key)[1]
    const visited = new Set<string>([key])
    let destination = host
    let next = JSON.stringify([destination, repo])
    while (routes.has(next) && !visited.has(next)) {
      visited.add(next)
      destination = pendingHosts.get(next) ?? routes.get(next) ?? destination
      next = JSON.stringify([destination, repo])
    }
    for (const source of visited) {
      pendingHosts.set(source, destination)
    }
  }
}
let sequence = 0
const prefix = 'agent-setup:'
const scopeOf = (owner: NativeChatComposerDraftOwner, agent: string): string =>
  prefix + JSON.stringify([owner.executionHostId, owner.workspaceId, agent])

/** Session references follow accepted context changes; the ordinary persisted key stays reconstructible. */
export const launchDraftSource = (scope: string): LaunchDraftSource | undefined =>
  handles.get(scope) ?? setups.get(scope)
export const currentDraftScope = (scope: string): string => handles.get(scope)?.scopeKey ?? scope
export function nativeChatLaunchPromptDraftOwner(
  scope: string
): NativeChatComposerDraftOwner | undefined {
  scope = currentDraftScope(scope)
  if (!scope.startsWith(prefix)) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(scope.slice(prefix.length))
    if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') {
      const host = parseExecutionHostId(value[0])
      if (host) {
        return { executionHostId: host.id, workspaceId: value[1] }
      }
    }
  } catch {
    /* Ordinary malformed keys have no setup attribution. */
  }
  return undefined
}
export function nativeChatLaunchPromptDraftScopeKey(
  workspaceId: string,
  agent: string,
  executionHostId = 'local'
): string {
  const initialOwner = {
    workspaceId,
    executionHostId: parseExecutionHostId(executionHostId)?.id ?? 'local'
  }
  const owner = {
    ...initialOwner,
    executionHostId:
      pendingHosts.get(
        JSON.stringify([initialOwner.executionHostId, getRepoIdFromWorktreeId(workspaceId)])
      ) ?? initialOwner.executionHostId
  }
  const key = scopeOf(owner, agent)
  let setup = setups.get(key)
  if (!setup) {
    setup = {
      ...owner,
      scopeKey: key,
      agent,
      origin: executionHostId.startsWith('runtime:') ? executionHostId : 'local',
      handles: new Map(),
      references: new Map(),
      optionListeners: new Set()
    }
    setups.set(key, setup)
  }
  const existing = setup.references.get(key)
  if (existing) {
    return existing
  }
  const handle = `agent-setup-reference:${++sequence}`
  setup.references.set(key, handle)
  handles.set(handle, setup)
  setup.handles.set(handle, {
    scopeKey: key,
    active: true,
    initialScope: scopeOf(initialOwner, agent)
  })
  return handle
}
/** Keep each accepted context as a direct captured reference, never a redirect chain. */
export function associateLaunchDraftContext(
  source: LaunchDraftSource,
  executionHostId: ExecutionHostId
): void {
  const key = scopeOf({ workspaceId: source.workspaceId, executionHostId }, source.agent)
  if (source.references.has(key)) {
    return
  }
  const reference = `agent-setup-reference:${++sequence}`
  source.references.set(key, reference)
  source.handles.set(reference, { scopeKey: source.scopeKey, active: true, initialScope: key })
  handles.set(reference, source)
}
export const launchDraftSources = (): Iterable<LaunchDraftSource> => setups.values()
export function relocateLaunchDraftSource(
  source: LaunchDraftSource,
  owner: NativeChatComposerDraftOwner
): LaunchDraftSource {
  if (setups.get(source.scopeKey) === source) {
    setups.delete(source.scopeKey)
  }
  const key = scopeOf(owner, source.agent)
  const target = setups.get(key) ?? source
  if (target !== source) {
    target.options ??= source.options
    for (const [scope, reference] of source.references) {
      if (!target.references.has(scope)) {
        target.references.set(scope, reference)
      }
    }
    for (const listener of source.optionListeners) {
      target.optionListeners.add(listener)
    }
  }
  Object.assign(target, owner, { scopeKey: key })
  for (const [key, handle] of source.handles) {
    handle.scopeKey = target.scopeKey
    target.handles.set(key, handle)
    handles.set(key, target)
  }
  if (target !== source) {
    source.handles.clear()
  }
  setups.set(key, target)
  return target
}
export const captureLaunchDraftDestination = (scope: string): SetupHandle | undefined =>
  launchDraftSource(scope)?.handles.values().next().value
export function readLaunchSetupOptions(scope: string): AgentPickerDraft | undefined {
  return launchDraftSource(scope)?.options
}
export function writeLaunchSetupOptions(scope: string, draft: AgentPickerDraft): void {
  const setup = launchDraftSource(scope)
  if (setup) {
    setup.options = draft
    setup.optionListeners.forEach((listener) => listener())
  }
}
export function subscribeLaunchSetupOptions(scope: string, listener: () => void): () => void {
  launchDraftSource(scope)?.optionListeners.add(listener)
  return () => {
    launchDraftSource(scope)?.optionListeners.delete(listener)
  }
}
export function clearLaunchDraftSourcesForTests(): void {
  handles.clear()
  setups.clear()
  pendingHosts.clear()
}
