import type { editor } from 'monaco-editor'
import {
  invalidateCombinedEditorGeometry,
  measureCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { untilDiffCommentZoneRemoved } from './diff-comment-zone-lifetime'
import type { ResizableZoneEntry } from './diff-comment-view-zone-entry'

type Measurement = {
  entry: ResizableZoneEntry
  current(): boolean
  measured(): void
}
type PaneMeasurements = {
  entries: Map<ResizableZoneEntry, Measurement>
  flush(): void
  request(entry: ResizableZoneEntry): void
  remove(measurement: Measurement): void
  dispose(): void
}
const panes = new WeakMap<editor.ICodeEditor, PaneMeasurements>()

export function readDiffCommentZoneHeight(entry: ResizableZoneEntry): number | null {
  const childHeight = entry.domNode.firstElementChild?.getBoundingClientRect().height ?? 0
  if (childHeight <= 0) {
    return null
  }
  const style = window.getComputedStyle(entry.domNode)
  return Math.ceil(
    childHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
  )
}

function measurePane(editor: editor.ICodeEditor, entries: Iterable<Measurement>): void {
  const live = [...entries].filter(({ entry, current }) => {
    if (!current() || !entry.domNode.isConnected) {
      return false
    }
    const zone = editor.getViewZoneBounds(entry.zoneId)
    return zone !== null && !zone.hidden
  })
  if (live.length === 0) {
    return
  }
  const first = live[0].entry
  const parent = first.domNode.parentElement
  const heights = new Map<Measurement, number>()
  measureCombinedCommentZone(editor, first.zoneId, first.domNode, () => {
    const styles = live.map(({ entry }) => ({
      node: entry.domNode,
      display: entry.domNode.style.display,
      visibility: entry.domNode.style.visibility
    }))
    try {
      // One native parent width preparation surrounds all writes, then all intrinsic reads.
      for (const { node, display } of styles) {
        if (node.parentElement === parent && display === 'none') {
          node.style.visibility = 'hidden'
          node.style.display = 'block'
        }
      }
      for (const measurement of live) {
        if (!measurement.current() || measurement.entry.domNode.parentElement !== parent) {
          continue
        }
        const height = readDiffCommentZoneHeight(measurement.entry)
        if (height !== null) {
          heights.set(measurement, height)
        }
      }
    } finally {
      for (const { node, display, visibility } of styles) {
        node.style.display = display
        node.style.visibility = visibility
      }
    }
    return true
  })
  const changed = [...heights].filter(
    ([measurement, height]) =>
      measurement.current() && measurement.entry.delegate.heightInPx !== height
  )
  if (changed.length > 0) {
    editor.changeViewZones((accessor) => {
      for (const [measurement, height] of changed) {
        if (measurement.current()) {
          measurement.entry.delegate.heightInPx = height
          accessor.layoutZone(measurement.entry.zoneId)
        }
      }
    })
    invalidateCombinedEditorGeometry(editor)
  }
  for (const measurement of heights.keys()) {
    if (measurement.current()) {
      measurement.measured()
    }
  }
}

export function registerDiffCommentZoneMeasurement(
  editor: editor.ICodeEditor,
  entry: ResizableZoneEntry,
  signal: AbortSignal,
  current: () => boolean,
  measured: () => void
): void {
  let pane = panes.get(editor)
  if (!pane) {
    pane = createPaneMeasurements(editor)
    panes.set(editor, pane)
  }
  const measurement = { entry, current, measured }
  const owner = pane
  owner.entries.set(entry, measurement)
  untilDiffCommentZoneRemoved(signal, () => {
    owner.remove(measurement)
    if (owner.entries.size === 0) {
      owner.dispose()
    }
  })
}

function createPaneMeasurements(editor: editor.ICodeEditor): PaneMeasurements {
  const entries = new Map<ResizableZoneEntry, Measurement>()
  const dirty = new Set<Measurement>()
  let queued: object | null = null
  let flushing = false
  let widthPending = false
  let measuredWidth = -1
  const active = (): boolean => panes.get(editor) === pane && entries.size > 0
  const schedule = (): void => {
    if (!active() || queued) {
      return
    }
    const request = (queued = {})
    queueMicrotask(() => {
      if (queued !== request) {
        return
      }
      queued = null
      pane.flush()
    })
  }
  const pane: PaneMeasurements = {
    entries,
    flush: () => {
      if (!active()) {
        return
      }
      if (flushing) {
        schedule()
        return
      }
      queued = null
      widthPending = false
      const width = currentWidth()
      const pending = width !== measuredWidth ? [...entries.values()] : [...dirty]
      dirty.clear()
      if (pending.length === 0) {
        return
      }
      flushing = true
      try {
        measuredWidth = width
        measurePane(editor, pending)
      } finally {
        flushing = false
      }
    },
    request: (entry) => {
      const measurement = entries.get(entry)
      if (active() && measurement?.current()) {
        dirty.add(measurement)
        schedule()
      }
    },
    remove: (measurement) => {
      if (entries.get(measurement.entry) === measurement) {
        entries.delete(measurement.entry)
      }
      dirty.delete(measurement)
      if (dirty.size === 0 && !widthPending) {
        queued = null
      }
    },
    dispose: () => {
      layoutSubscription.dispose()
      contentSubscription.dispose()
      entries.clear()
      dirty.clear()
      queued = null
      widthPending = false
      if (panes.get(editor) === pane) {
        panes.delete(editor)
      }
    }
  }
  function currentWidth(): number {
    const contentWidth = editor.getLayoutInfo().contentWidth
    return contentWidth > 0 ? Math.max(editor.getScrollWidth(), contentWidth) : 0
  }
  const widthChanged = (): void => {
    if (active() && currentWidth() !== measuredWidth) {
      widthPending = true
      pane.flush()
    }
  }
  const layoutSubscription = editor.onDidLayoutChange(widthChanged)
  const contentSubscription = editor.onDidContentSizeChange(widthChanged)
  return pane
}

export function requestDiffCommentZoneMeasurement(
  editor: editor.ICodeEditor,
  entry: ResizableZoneEntry
): void {
  panes.get(editor)?.request(entry)
}
