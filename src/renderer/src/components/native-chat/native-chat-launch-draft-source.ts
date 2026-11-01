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
  /** Authored options per slot: the plain row's empty slot, or a search preset's own. */
  options?: Map<string, AgentPickerDraft>
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
const referencePrefix = 'agent-setup-reference:'
const scopeOf = (owner: NativeChatComposerDraftOwner, agent: string): string =>
  prefix + JSON.stringify([owner.executionHostId, owner.workspaceId, agent])
function setupOf(scope: string): (NativeChatComposerDraftOwner & { agent: string }) | undefined {
  if (!scope.startsWith(prefix)) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(scope.slice(prefix.length))
    if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') {
      const host = parseExecutionHostId(value[0])
      if (host) {
        return { executionHostId: host.id, workspaceId: value[1], agent: String(value[2]) }
      }
    }
  } catch {
    /* Ordinary malformed keys have no setup attribution. */
  }
  return undefined
}
/** A row's reference names its session key and pre-routing owner, so reading it needs no record. */
function referenceOf(scope: string): readonly [key: string, initialScope: string] | undefined {
  if (!scope.startsWith(`${referencePrefix}[`)) {
    return undefined
  }
  try {
    const [key, initialScope]: unknown[] = JSON.parse(scope.slice(referencePrefix.length))
    return typeof key === 'string' && typeof initialScope === 'string'
      ? [key, initialScope]
      : undefined
  } catch {
    return undefined
  }
}
function referenceFor(key: string, initialScope: string): string {
  for (let generation = 0; ; generation++) {
    const reference =
      referencePrefix +
      JSON.stringify(generation ? [key, initialScope, generation] : [key, initialScope])
    const held = handles.get(reference)
    // A written reference keeps following its source; a row derived here after it moved starts fresh.
    if (!held || held.scopeKey === key) {
      return reference
    }
  }
}

/** Session references follow accepted context changes; the qualified session key stays reconstructible. */
export const launchDraftSource = (scope: string): LaunchDraftSource | undefined =>
  handles.get(scope) ?? setups.get(referenceOf(scope)?.[0] ?? scope)
export const currentDraftScope = (scope: string): string =>
  handles.get(scope)?.scopeKey ?? referenceOf(scope)?.[0] ?? scope
export function nativeChatLaunchPromptDraftOwner(
  scope: string
): NativeChatComposerDraftOwner | undefined {
  const setup = setupOf(currentDraftScope(scope))
  return setup && { executionHostId: setup.executionHostId, workspaceId: setup.workspaceId }
}
/** Deriving a row's key reads only; rows never opened or written keep no session record. */
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
  return referenceFor(scopeOf(owner, agent), scopeOf(initialOwner, agent))
}
/** The first authored write creates the session source, as main kept only authored setups. */
export function retainLaunchDraftSource(scope: string): LaunchDraftSource | undefined {
  const held = launchDraftSource(scope)
  const reference = referenceOf(scope)
  if (held && (handles.has(scope) || !reference)) {
    return held
  }
  const [key, initialScope] = reference ?? [scope, scope]
  const owner = setupOf(key)
  const initial = setupOf(initialScope)
  if (!owner || !initial) {
    return undefined
  }
  if (!reference) {
    scope = referenceFor(key, key)
  }
  let setup = setups.get(key)
  if (!setup) {
    setup = {
      executionHostId: owner.executionHostId,
      workspaceId: owner.workspaceId,
      scopeKey: key,
      agent: owner.agent,
      origin: initial.executionHostId.startsWith('runtime:') ? initial.executionHostId : 'local',
      handles: new Map(),
      references: new Map()
    }
    setups.set(key, setup)
  }
  if (!setup.references.has(key)) {
    setup.references.set(key, scope)
  }
  handles.set(scope, setup)
  setup.handles.set(scope, { scopeKey: key, active: true, initialScope })
  return setup
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
    for (const [slot, draft] of source.options ?? []) {
      target.options ??= new Map()
      if (!target.options.has(slot)) {
        target.options.set(slot, draft)
      }
    }
    for (const [scope, reference] of source.references) {
      if (!target.references.has(scope)) {
        target.references.set(scope, reference)
      }
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
export function captureLaunchDraftDestination(
  scope: string
): { readonly scopeKey: string; readonly active: boolean } | undefined {
  const held = launchDraftSource(scope)?.handles.values().next().value
  if (held || !referenceOf(scope)) {
    return held
  }
  // Not yet written: the first write retains this reference, which the destination then follows.
  return {
    get scopeKey() {
      return currentDraftScope(scope)
    },
    active: true
  }
}
export function readLaunchSetupOptions(scope: string, slot = ''): AgentPickerDraft | undefined {
  return launchDraftSource(scope)?.options?.get(slot)
}
export function clearLaunchDraftSourcesForTests(): void {
  handles.clear()
  setups.clear()
  pendingHosts.clear()
}
