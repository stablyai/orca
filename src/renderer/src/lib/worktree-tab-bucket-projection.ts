import { readRecordChanges } from '@/store/keyed-record-change-reads'

export type WorktreeTabBucketProjection<T, P> = {
  project: (source: Readonly<Record<string, readonly T[]>>) => Record<string, P[]>
}

export function createWorktreeTabBucketProjection<T, P>(args: {
  projectTab: (tab: T) => P
  isSameProjectedTab: (previous: P, next: T) => boolean
  onInspectBucket?: (worktreeId: string) => void
}): WorktreeTabBucketProjection<T, P> {
  let previousSource: Readonly<Record<string, readonly T[]>> | null = null
  let previousProjection: Record<string, P[]> | null = null
  const projectionBySourceBucket = new WeakMap<readonly T[], P[]>()

  return {
    project(source) {
      if (source === previousSource && previousProjection) {
        return previousProjection
      }

      const changes = previousSource ? readRecordChanges(source, previousSource) : null
      const knownKeys = changes?.kind === 'addressed' ? changes.keys : null
      const sourceKeys =
        changes?.kind === 'addressed'
          ? [...changes.keys]
              .filter((key) => Object.hasOwn(previousSource!, key))
              .concat(changes.added)
          : Object.keys(source)
      let changed =
        previousProjection === null ||
        (!knownKeys && sourceKeys.length !== Object.keys(previousProjection).length)
      const nextProjection: Record<string, P[]> = knownKeys ? { ...previousProjection } : {}

      for (const worktreeId of sourceKeys) {
        if (!(worktreeId in source)) {
          if (worktreeId in nextProjection) {
            changed = true
          }
          delete nextProjection[worktreeId]
          continue
        }
        const sourceTabs = source[worktreeId] ?? []
        const previousTabs = previousProjection?.[worktreeId]
        let projectedTabs: P[]

        if (previousSource?.[worktreeId] === sourceTabs && previousTabs) {
          projectedTabs = previousTabs
        } else {
          args.onInspectBucket?.(worktreeId)
          const cached = projectionBySourceBucket.get(sourceTabs)
          if (cached) {
            projectedTabs = cached
          } else if (
            previousTabs &&
            previousTabs.length === sourceTabs.length &&
            sourceTabs.every((tab, index) => {
              const previousTab = previousTabs[index]
              return previousTab !== undefined && args.isSameProjectedTab(previousTab, tab)
            })
          ) {
            projectedTabs = previousTabs
          } else {
            projectedTabs = sourceTabs.map(args.projectTab)
          }
          projectionBySourceBucket.set(sourceTabs, projectedTabs)
        }

        nextProjection[worktreeId] = projectedTabs
        if (projectedTabs !== previousTabs) {
          changed = true
        }
      }

      previousSource = source
      if (!changed && previousProjection) {
        return previousProjection
      }
      previousProjection = nextProjection
      return nextProjection
    }
  }
}
