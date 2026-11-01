import type { editor } from 'monaco-editor'
import type { KeyboardEvent } from 'react'
import {
  hasCombinedDiffNavigation,
  requestCombinedDiffComment,
  type CombinedDiffCommentOperation
} from '../editor/combined-diff-navigation'
import type { ResizableZoneEntry } from './diff-comment-view-zone-entry'

function reservedZoneTop(pane: editor.ICodeEditor, entry: ResizableZoneEntry): number | undefined {
  if (!('getWhitespaces' in pane) || typeof pane.getWhitespaces !== 'function') {
    return undefined
  }
  const spaces: unknown = pane.getWhitespaces()
  if (!Array.isArray(spaces)) {
    return undefined
  }
  const ordered = spaces.filter(
    (space): space is { id: string; afterLineNumber: number; height: number } =>
      typeof space === 'object' &&
      space !== null &&
      typeof space.id === 'string' &&
      Number.isFinite(space.afterLineNumber) &&
      Number.isFinite(space.height)
  )
  const index = ordered.findIndex((space) => space.id === entry.zoneId)
  const target = ordered[index]
  if (!target) {
    return undefined
  }
  return (
    pane.getBottomForLineNumber(entry.delegate.afterLineNumber) +
    ordered
      .slice(0, index)
      .reduce(
        (height, space) =>
          height + (space.afterLineNumber === target.afterLineNumber ? space.height : 0),
        0
      )
  )
}

export function createDiffCommentVisibility(
  pane: editor.ICodeEditor,
  entry: () => ResizableZoneEntry | null | undefined
) {
  let operation: CombinedDiffCommentOperation | undefined
  let localFrame = 0
  const combined = hasCombinedDiffNavigation(pane.getContainerDomNode())
  const cancel = (): void => {
    operation?.dispose()
    operation = undefined
    cancelAnimationFrame(localFrame)
    localFrame = 0
  }
  const reveal = (control?: HTMLElement, focus = true, complete?: () => void): void => {
    cancel()
    if (!combined) {
      if (!focus) {
        localFrame = requestAnimationFrame(() => {
          localFrame = 0
          const zone = entry()
          if (!zone || !pane.getModel()) {
            return
          }
          pane.setScrollTop(
            Math.max(
              0,
              pane.getTopForLineNumber(zone.delegate.afterLineNumber, true) -
                pane.getLayoutInfo().height / 2
            )
          )
          complete?.()
        })
      }
      return
    }
    const model = pane.getModel()
    let onSettled = complete
    const settle = (): void => {
      const callback = onSettled
      onSettled = undefined
      callback?.()
    }
    operation = requestCombinedDiffComment(pane.getContainerDomNode(), {
      read: (available) => {
        const zone = entry()
        if (!zone || pane.getModel() !== model) {
          return undefined
        }
        const card = zone.domNode.firstElementChild
        const bounds = card?.getBoundingClientRect()
        const nativeTop = reservedZoneTop(pane, zone)
        if (!bounds?.height || zone.domNode.style.display === 'none') {
          return nativeTop === undefined
            ? undefined
            : {
                top: nativeTop,
                bottom: nativeTop + (zone.delegate.heightInPx ?? 0),
                measured: false
              }
        }
        const focused = control ?? zone.domNode.querySelector<HTMLElement>('textarea')
        const rect = bounds.height > available && focused ? focused.getBoundingClientRect() : bounds
        const origin = pane.getContainerDomNode().getBoundingClientRect().top - pane.getScrollTop()
        return { top: rect.top - origin, bottom: rect.bottom - origin, measured: true }
      },
      cancelled: settle,
      complete: () => {
        operation = undefined
        settle()
        if (focus) {
          ;(control ?? entry()?.domNode.querySelector<HTMLElement>('textarea'))?.focus({
            preventScroll: true
          })
        }
      }
    })
  }
  return {
    combined,
    reveal,
    cancel,
    update: (): void => operation?.update(),
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      if (!combined || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }
      const controls = [
        ...(entry()?.domNode.querySelectorAll<HTMLElement>(
          'textarea, button:not(:disabled), a[href]'
        ) ?? [])
      ]
      const index = event.target instanceof HTMLElement ? controls.indexOf(event.target) : -1
      const next = controls[index + (event.shiftKey ? -1 : 1)]
      if (index === -1 || !next) {
        return
      }
      event.preventDefault()
      reveal(next)
    }
  }
}

export type DiffCommentVisibility = ReturnType<typeof createDiffCommentVisibility>
