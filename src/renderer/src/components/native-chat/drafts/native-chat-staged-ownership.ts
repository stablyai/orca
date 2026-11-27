import type { StagedFiles } from './native-chat-draft-attachment-staging'
const versions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
const pending = new Set<() => void>()
let scheduled = false
let version = 0

/** Only accounts naming a changed original hear an ownership edit. */
export function nativeChatStagedOwnershipChanged(paths: Iterable<string>): void {
  version += 1
  for (const path of paths) {
    if (listeners.has(path)) {
      versions.set(path, version)
      for (const listener of listeners.get(path)!) {
        pending.add(listener)
      }
    }
  }
  if (!pending.size || scheduled) {
    return
  }
  scheduled = true
  void Promise.resolve().then(() => {
    scheduled = false
    const ready = [...pending]
    pending.clear()
    for (const listener of ready) {
      listener()
    }
  })
}

export function nativeChatStagedOwnershipVersion(paths?: readonly string[]): number {
  return paths
    ? paths.reduce((latest, path) => Math.max(latest, versions.get(path) ?? version), 0)
    : version
}

export function subscribeToNativeChatStagedOwnership(
  listener: () => void,
  paths: readonly string[]
): () => void {
  for (const path of paths) {
    if (!versions.has(path)) {
      versions.set(path, version)
    }
    const scoped = listeners.get(path) ?? new Set()
    scoped.add(listener)
    listeners.set(path, scoped)
  }
  return () => {
    pending.delete(listener)
    for (const path of paths) {
      const scoped = listeners.get(path)
      scoped?.delete(listener)
      if (!scoped?.size) {
        listeners.delete(path)
        versions.delete(path)
      }
    }
  }
}

const retiredLeases = new WeakSet<Set<string>>()
export function nativeChatStagedLeaseRetired(lease: Set<string>): boolean {
  return retiredLeases.has(lease)
}
const draftHolders = new Map<string, Set<string>>()

export function updateDraftHolders(
  scope: string,
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>
): void {
  const changed: string[] = []
  for (const path of previous) {
    if (!next.has(path)) {
      const holders = draftHolders.get(path)
      holders?.delete(scope)
      if (!holders?.size) {
        draftHolders.delete(path)
      }
      changed.push(path)
    }
  }
  for (const path of next) {
    if (!previous.has(path)) {
      const holders = draftHolders.get(path) ?? new Set()
      holders.add(scope)
      draftHolders.set(path, holders)
      changed.push(path)
    }
  }
  if (changed.length) {
    nativeChatStagedOwnershipChanged(changed)
  }
}

export function nativeChatStagedFileDraftHolderScopes(path: string): string[] {
  return [...(draftHolders.get(path) ?? [])]
}

export function retireNativeChatStagedLeases(leases: Iterable<Set<string>>): void {
  for (const lease of leases) {
    retiredLeases.add(lease)
  }
}

export function nativeChatStagedDraftReferences(files: StagedFiles): Set<string> {
  const draft = files.draft
  return new Set([
    ...(draft?.images.map(({ path }) => path) ?? []),
    ...Object.values(draft?.pastedTextFiles ?? {}),
    ...files.textReferences
  ])
}
