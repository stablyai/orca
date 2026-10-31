import { useCallback, useState, type SetStateAction } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { measureVirtualRowRetainingHiddenSize } from '@/hooks/virtualized-hidden-row-measurement'
import type { DiffSection } from './diff-section-types'
import { getDiffSectionRowEstimatedHeight } from './diff-section-layout'

type Heights = Record<number, number>
export type SetDiffSectionHeights = (
  update: SetStateAction<Heights>,
  restored?: DiffSection[]
) => void
type HeightRecord = { height?: number; row: { chrome?: number } }

export type DiffSectionHeightAuthority = {
  estimateSize: (index: number) => number
  measureElement: (
    element: Element,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, Element>
  ) => number
}

const terminal = (section: DiffSection): boolean =>
  Boolean(
    section.loadOnDemand ||
    section.largeDiffRenderLimit?.limited ||
    (!section.loading &&
      (section.error ||
        section.diffResult?.kind === 'binary' ||
        (section.diffResult?.kind === 'text' &&
          !section.originalContent &&
          !section.modifiedContent)))
  )

function liveRecords(
  sections: DiffSection[],
  previous: Map<string, HeightRecord>
): Map<string, HeightRecord> {
  return new Map(
    sections.map((section) => [
      section.key,
      terminal(section) ? { row: {} } : (previous.get(section.key) ?? { row: {} })
    ])
  )
}

function indexed(sections: DiffSection[], records: Map<string, HeightRecord>): Heights {
  const heights: Heights = {}
  sections.forEach((section, index) => {
    const height = records.get(section.key)?.height
    if (height !== undefined) {
      heights[index] = height
    }
  })
  return heights
}

/** A live file owns expanded geometry; a native binding only publishes its current measurement. */
export function useDiffSectionHeights(
  context: string,
  sections: DiffSection[]
): [Heights, SetDiffSectionHeights, DiffSectionHeightAuthority] {
  const [state, setState] = useState(() => ({
    context,
    sections,
    scope: {},
    records: liveRecords(sections, new Map())
  }))
  let current = state
  if (
    state.context !== context ||
    state.sections.length !== sections.length ||
    state.sections.some((section, index) => section !== sections[index])
  ) {
    current = {
      context,
      sections,
      scope: state.context === context ? state.scope : {},
      records: liveRecords(sections, state.context === context ? state.records : new Map())
    }
    setState(current)
  }
  const records = current.records
  const scope = current.scope
  const setHeights = useCallback<SetDiffSectionHeights>(
    (update, restored) => {
      setState((previous) => {
        if (previous.scope !== scope) {
          return previous
        }
        const target = restored ?? previous.sections
        const values = indexed(target, previous.records)
        const next = typeof update === 'function' ? update(values) : update
        if (next === values) {
          return previous
        }
        const nextRecords = restored
          ? liveRecords(restored, previous.records)
          : new Map(previous.records)
        let changed = Boolean(restored)
        target.forEach((section, index) => {
          const record = nextRecords.get(section.key)
          if (!record) {
            return
          }
          const height = terminal(section) ? undefined : next[index]
          if (height !== record.height) {
            changed = true
            nextRecords.set(section.key, { ...record, height })
          }
        })
        return changed ? { context, scope, sections: target, records: nextRecords } : previous
      })
    },
    [context, scope]
  )
  const estimateSize = (index: number): number => {
    const section = sections[index]
    if (!section) {
      return 88
    }
    const record = records.get(section.key)
    return !section.collapsed &&
      !terminal(section) &&
      record?.height !== undefined &&
      record.row.chrome !== undefined
      ? record.height + record.row.chrome
      : getDiffSectionRowEstimatedHeight(section, record?.height)
  }
  const measureElement: DiffSectionHeightAuthority['measureElement'] = (
    element,
    entry,
    instance
  ) => {
    const index = instance.indexFromElement(element)
    const section = sections[index]
    const record = section && records.get(section.key)
    const height = measureVirtualRowRetainingHiddenSize(element, entry, instance)
    if (
      entry &&
      record?.height !== undefined &&
      section &&
      !section.collapsed &&
      !terminal(section)
    ) {
      record.row.chrome = height - record.height
    }
    return height
  }
  return [indexed(sections, records), setHeights, { estimateSize, measureElement }]
}

export function removeDiffSectionMeasuredHeight(heights: Heights, index: number): Heights {
  if (!(index in heights)) {
    return heights
  }
  const { [index]: _removed, ...rest } = heights
  void _removed
  return rest
}
