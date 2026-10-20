import { useMemo } from 'react'
import type {
  PerforceEntry,
  PerforceStatusResult
} from '../../../../../shared/perforce/perforce-types'

export function rowKey(entry: PerforceEntry): string {
  return `${entry.group}:${entry.path}`
}

/** Splits status entries into the panel's sections, plus the row order used for shift-click ranges. */
export function usePerforceGroups(status: PerforceStatusResult | null) {
  const groups = useMemo(() => {
    const entries = status?.entries ?? []
    const opened = entries.filter((entry) => entry.group === 'opened')
    return {
      defaultList: opened.filter((entry) => entry.changelist === 'default'),
      numbered: (status?.changelists ?? []).map((changelist) => ({
        changelist,
        files: opened.filter((entry) => entry.changelist === changelist.id)
      })),
      modified: entries.filter((entry) => entry.group === 'modified'),
      fresh: entries.filter((entry) => entry.group === 'new')
    }
  }, [status])

  const orderedKeys = useMemo(
    () =>
      [
        ...groups.defaultList,
        ...groups.numbered.flatMap(({ files }) => files),
        ...groups.modified,
        ...groups.fresh
      ].map((entry) => rowKey(entry)),
    [groups]
  )
  return { groups, orderedKeys }
}
