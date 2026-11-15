import { readRecordChanges } from '@/store/keyed-record-change-reads'

export type WorktreeTabBucketProjection<T, P> = {
  project: (source: Readonly<Record<string, readonly T[]>>) => Record<string, P[]>
}

function diffUnknownProjectionKeys(source: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(source)
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
          : diffUnknownProjectionKeys(source)
      let changed =
        previousProjection === null ||
        (!knownKeys && sourceKeys.length !== Object.keys(previousProjection).length)
      let nextProjection: Record<string, P[]> | null = null
      const writableProjection = (): Record<string, P[]> => {
        if (nextProjection) {
          return nextProjection
        }
        if (knownKeys) {
          return (nextProjection = { ...previousProjection })
        }
        nextProjection = {}
        if (previousProjection) {
          for (const id of sourceKeys) {
            nextProjection[id] = previousProjection[id] ?? []
          }
        }
        return nextProjection
      }

      for (const worktreeId of sourceKeys) {
        if (!(worktreeId in source)) {
          if (previousProjection && worktreeId in previousProjection) {
            changed = true
            delete writableProjection()[worktreeId]
          }
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

        if (
          projectedTabs !== previousTabs ||
          !previousProjection ||
          !(worktreeId in previousProjection)
        ) {
          changed = true
          writableProjection()[worktreeId] = projectedTabs
        }
      }

      previousSource = source
      if (!changed && previousProjection) {
        return previousProjection
      }
      previousProjection = writableProjection()
      return previousProjection
    }
  }
}
