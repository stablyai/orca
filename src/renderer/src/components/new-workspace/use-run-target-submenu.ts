import { useCallback, useMemo, useState } from 'react'
import type { RunTargetSubmenu } from './run-target-options'

/**
 * Which submenu is open and which of its rows holds the keyboard arm. A null arm means focus is
 * still on the parent row (hover-opened); arrow keys then keep moving the main list.
 */
export function useRunTargetSubmenu(
  itemKeysFor: (submenu: RunTargetSubmenu) => readonly string[]
): {
  submenu: RunTargetSubmenu | null
  armedItemKey: string | null
  /** `armFirst` moves keyboard focus into the submenu, as Enter/ArrowRight do. */
  openSubmenu: (submenu: RunTargetSubmenu, armFirst: boolean) => void
  closeSubmenu: () => void
  armItem: (key: string | null) => void
  /** Moves the arm by `step`, wrapping like a native menu. */
  moveItemArm: (step: number) => void
  /** Home/End inside the submenu. */
  armItemEdge: (edge: 'first' | 'last') => void
} {
  const [state, setState] = useState<{ submenu: RunTargetSubmenu | null; armed: string | null }>({
    submenu: null,
    armed: null
  })
  const keys = useMemo(
    () => (state.submenu ? itemKeysFor(state.submenu) : []),
    [itemKeysFor, state.submenu]
  )
  // A filtered-away arm reads as no arm rather than pointing at a missing row.
  const armedItemKey = state.armed !== null && keys.includes(state.armed) ? state.armed : null

  const openSubmenu = useCallback(
    (submenu: RunTargetSubmenu, armFirst: boolean): void => {
      setState({ submenu, armed: armFirst ? (itemKeysFor(submenu)[0] ?? null) : null })
    },
    [itemKeysFor]
  )
  // Unchanged state returns the same object so per-mousemove calls never re-render the picker.
  const closeSubmenu = useCallback(
    (): void =>
      setState((current) =>
        current.submenu === null && current.armed === null
          ? current
          : { submenu: null, armed: null }
      ),
    []
  )
  const armItem = useCallback(
    (key: string | null): void =>
      setState((current) => (current.armed === key ? current : { ...current, armed: key })),
    []
  )
  const moveItemArm = useCallback(
    (step: number): void => {
      if (keys.length === 0) {
        return
      }
      const index = armedItemKey === null ? -1 : keys.indexOf(armedItemKey)
      const next =
        index === -1 ? (step > 0 ? 0 : keys.length - 1) : (index + step + keys.length) % keys.length
      armItem(keys[next] ?? null)
    },
    [armItem, armedItemKey, keys]
  )

  const armItemEdge = useCallback(
    (edge: 'first' | 'last'): void => armItem((edge === 'first' ? keys[0] : keys.at(-1)) ?? null),
    [armItem, keys]
  )

  return {
    submenu: state.submenu,
    armedItemKey,
    openSubmenu,
    closeSubmenu,
    armItem,
    moveItemArm,
    armItemEdge
  }
}
