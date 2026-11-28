import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { focusWorkerDockPaneEditor } from './worker-dock-focus-return'

/** Moves focus between the card's rows, and hands it on when the focused row leaves. */
export function useWorkerDockCardFocus({
  items,
  rows,
  loadRow,
  small,
  virtual,
  viewport,
  pill,
  hold
}: {
  items: readonly { id: string }[]
  rows: ReadonlyMap<string, unknown>
  loadRow: (id: string) => void
  small: boolean
  virtual: Virtualizer<HTMLDivElement, HTMLDivElement>
  viewport: RefObject<HTMLDivElement | null>
  pill: RefObject<HTMLButtonElement | null>
  hold: () => void
}) {
  const navigation = useRef(0)
  useEffect(
    () => () => {
      navigation.current++
    },
    []
  )
  const focusRow = (index: number) => {
    const target = items[Math.max(0, Math.min(index, items.length - 1))]
    if (!target) {
      return
    }
    hold()
    if (!rows.has(target.id)) {
      loadRow(target.id)
    }
    // A newer move, or focus the user put elsewhere meanwhile, cancels this one.
    const token = ++navigation.current
    const origin = document.activeElement
    const current = () =>
      token === navigation.current &&
      (document.activeElement === origin || document.activeElement === document.body)
    const focusTarget = () => {
      const element = viewport.current?.querySelector<HTMLElement>(
        `[data-worker-dock-row="${CSS.escape(target.id)}"] [data-worker-dock-open]`
      )
      element?.focus()
      return Boolean(element)
    }
    if (small) {
      focusTarget()
      return
    }
    virtual.scrollToIndex(items.indexOf(target), { align: 'auto' })
    // A far row is drawn only once the scroll lands, a frame or a few later: keep trying until it is.
    const attempt = (left: number) => {
      if (current() && !focusTarget() && left > 0) {
        requestAnimationFrame(() => attempt(left - 1))
      }
    }
    requestAnimationFrame(() => attempt(10))
  }
  // A row that leaves while it holds focus (Clear, say) hands focus to the row that takes its
  // place, to the pill, or to the message box once the pill is gone, never to the page.
  const lastFocus = useRef<{ id: string; index: number; pane: Element | null } | null>(null)
  useLayoutEffect(() => {
    const saved = lastFocus.current
    if (!saved || items.some((row) => row.id === saved.id)) {
      return
    }
    lastFocus.current = null
    const focusedNow = document.activeElement
    if (focusedNow && focusedNow !== document.body) {
      return
    }
    const next = items[Math.min(saved.index, items.length - 1)]
    const target = next
      ? viewport.current?.querySelector<HTMLElement>(
          `[data-worker-dock-row="${CSS.escape(next.id)}"] [data-worker-dock-open]`
        )
      : null
    const landing = target ?? pill.current
    if (landing) {
      landing.focus()
    } else {
      focusWorkerDockPaneEditor(saved.pane)
    }
  }, [items, viewport, pill])
  // The whole card leaving (its chat's last work gone) while it held focus hands it to that
  // pane's message box, unless the user already put focus somewhere on purpose.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement
      const pane = (pill.current ?? viewport.current)?.closest('[data-native-chat-root]')
      if (
        !active ||
        !pane ||
        !(pill.current?.contains(active) || viewport.current?.contains(active))
      ) {
        return
      }
      queueMicrotask(() => {
        if (!document.activeElement || document.activeElement === document.body) {
          focusWorkerDockPaneEditor(pane)
        }
      })
    },
    [pill, viewport]
  )
  return {
    focusRow,
    rememberFocus: (id: string, pane: Element | null) => {
      lastFocus.current = { id, index: items.findIndex((item) => item.id === id), pane }
    },
    forgetFocus: () => {
      lastFocus.current = null
    }
  }
}
