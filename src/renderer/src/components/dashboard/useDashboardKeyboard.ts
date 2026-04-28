import { useEffect, useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { DashboardWorktreeCard } from './useDashboardData'
import type { DashboardFilter } from './useDashboardFilter'

type UseDashboardKeyboardParams = {
  filteredWorktrees: DashboardWorktreeCard[]
  focusedWorktreeId: string | null
  setFocusedWorktreeId: (id: string | null) => void
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
}

// Why: the listener must be scoped to the dashboard container so keystrokes
// (Arrow keys, digits 1-4, Enter, Escape) only fire when focus is inside the
// dashboard. Attaching to window intercepts terminal/xterm navigation (arrow
// keys for command history) and shell digit entry while the dashboard pane
// is merely open, which breaks those unrelated inputs.
//
// Why return a callback ref (and not accept a RefObject): AgentDashboard has
// an early-return branch that renders an empty state WITHOUT the container
// div when there are no repos. On initial render with no repos, a plain
// `useRef` would be null, our attach-effect would no-op, and then when repos
// later appear and the container mounts, React would NOT re-run the effect
// (a RefObject has stable identity, so its mutation doesn't trigger effects).
// The result: the keyboard listener would silently never attach on that path.
// A callback ref fires synchronously on attach/detach; storing the element in
// useState makes the effect re-run whenever the container appears or goes
// away, fixing the gap without any `ref.current`-as-dep anti-patterns.
type ContainerCallbackRef = (el: HTMLDivElement | null) => void

const FILTER_KEYS: Record<string, DashboardFilter> = {
  '1': 'all',
  '2': 'active',
  '3': 'blocked',
  '4': 'done'
}

export function useDashboardKeyboard({
  filteredWorktrees,
  focusedWorktreeId,
  setFocusedWorktreeId,
  filter,
  setFilter
}: UseDashboardKeyboardParams): ContainerCallbackRef {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  // Why: no `rightSidebarOpen` guard needed. The keydown listener is attached
  // to the dashboard container element (see attach-effect below), which lives
  // inside the right sidebar. When the sidebar is closed it collapses to 0
  // width with overflow hidden, so focus cannot land inside the dashboard,
  // and keydown events from the focused element (typically the terminal) are
  // never dispatched to the dashboard container. Subscribing to the flag here
  // would only cause this hook to recompute and re-attach the listener on
  // every sidebar toggle without adding any safety.

  // Why: track the container element in state so the attach-effect re-runs
  // whenever the element mounts or unmounts. See the file-level comment for
  // why a plain RefObject is insufficient here.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)

  // Why: stash data the handler reads in refs so it doesn't re-bind on every
  // agent-status update (which produces a fresh filteredWorktrees array most
  // renders). Without this, the listener is add/removed at PTY event rate.
  const filteredWorktreesRef = useRef(filteredWorktrees)
  const focusedWorktreeIdRef = useRef(focusedWorktreeId)
  const filterRef = useRef(filter)
  const containerElRef = useRef<HTMLDivElement | null>(null)
  // Why: mirror the three render-driven inputs into refs in a single
  // commit-phase effect so the stable handleKeyDown callback always reads
  // the latest values without re-binding the listener at PTY event rate.
  useEffect(() => {
    filteredWorktreesRef.current = filteredWorktrees
    focusedWorktreeIdRef.current = focusedWorktreeId
    filterRef.current = filter
  })
  useEffect(() => {
    // Why: mirror the element into a ref so the (stable) handleKeyDown
    // callback can query inside the current container without needing to
    // re-bind when the element identity changes.
    containerElRef.current = containerEl
  }, [containerEl])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't intercept when focus is in an editable element
      const target = e.target as HTMLElement
      if (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        return
      }

      // Don't intercept when a modifier key is held (let app shortcuts through)
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }

      // Filter quick-select: 1-4 keys.
      // Why: only fire when focus is on the dashboard container or a worktree
      // card, not on interactive descendants (dismiss X, expand chevron,
      // filter toggle, clear-search). Otherwise pressing a digit while such
      // a button is focused would silently change the filter — a foot-gun,
      // since buttons are common focus targets after clicks/keyboard nav.
      if (FILTER_KEYS[e.key]) {
        const onCardOrContainer =
          target === containerElRef.current || !!target.closest('[data-worktree-id]')
        if (!onCardOrContainer) {
          return
        }
        // Why: if the target itself is an interactive descendant of the worktree
        // card (dismiss X, expand chevron, filter toggle, clear-search button),
        // a digit keystroke would change the filter even though the user has a
        // nested button focused. Reject those so filter keys only fire from the
        // card surface itself or the dashboard container. (The container-is-target
        // fast path is already handled above.)
        if (target !== containerElRef.current) {
          const interactiveAncestor = target.closest(
            'button, a, input, textarea, select, [role="button"], [role="switch"], [role="tab"], [contenteditable="true"]'
          )
          if (interactiveAncestor && interactiveAncestor !== containerElRef.current) {
            return
          }
        }
        e.preventDefault()
        setFilter(FILTER_KEYS[e.key])
        return
      }

      // Escape: reset filter to 'all' (the default)
      if (e.key === 'Escape') {
        if (filterRef.current !== 'all') {
          e.preventDefault()
          setFilter('all')
        }
        return
      }

      // Arrow key navigation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const worktrees = filteredWorktreesRef.current
        const ids = worktrees.map((wt) => wt.worktree.id)
        if (ids.length === 0) {
          return
        }

        const focused = focusedWorktreeIdRef.current
        const currentIndex = focused ? ids.indexOf(focused) : -1

        let nextIndex: number
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          nextIndex = currentIndex < ids.length - 1 ? currentIndex + 1 : 0
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : ids.length - 1
        }

        const nextId = ids[nextIndex]
        setFocusedWorktreeId(nextId)

        // Focus the corresponding DOM card. Why: scope the lookup to the
        // dashboard container so we don't accidentally match a card rendered
        // elsewhere in the app (and so the query fails closed when the
        // container is unmounted).
        // Why: worktreeId is `${repoId}::${path}` (see src/shared/types.ts)
        // and filesystem paths can contain characters like `"` or `\` that
        // would otherwise break the attribute-selector string and throw a
        // SyntaxError, silently killing arrow-key navigation. CSS.escape()
        // safely encodes those special characters.
        const cardEl = containerElRef.current?.querySelector(
          `[data-worktree-id="${CSS.escape(nextId)}"]`
        ) as HTMLElement | null
        cardEl?.focus()
        return
      }

      // Enter: navigate to focused worktree.
      // Why: only fire when the native keydown target is the card itself OR
      // is nested inside one — but never on interactive descendants like the
      // dismiss X, expand chevron, clear-search button, or filter toggle,
      // whose own handlers would be blocked by preventDefault. Today the card
      // has no focusable descendants (the action buttons stopPropagation and
      // are reached via mouse, not keyboard Tab from the card), so using
      // `closest('[data-worktree-id]')` is safe AND robust against future
      // changes that might add focusable descendants elsewhere in the card.
      if (e.key === 'Enter' && focusedWorktreeIdRef.current) {
        const enterTarget = e.target as HTMLElement | null
        if (!enterTarget || !enterTarget.closest('[data-worktree-id]')) {
          return
        }
        e.preventDefault()
        setActiveWorktree(focusedWorktreeIdRef.current)
        setActiveView('terminal')
      }
    },
    [setFocusedWorktreeId, setFilter, setActiveWorktree, setActiveView]
  )

  useEffect(() => {
    // Why: attach to the dashboard container rather than window so these
    // shortcuts only fire when focus is inside the dashboard. This prevents
    // Arrow keys and digits 1-4 from hijacking the terminal (xterm history
    // navigation) and shell input while the dashboard pane is open.
    //
    // Why depend on `containerEl` (state) not a ref: the container is not
    // rendered on the empty-state branch, so it mounts *after* this hook
    // first runs once repos appear. State-backed tracking via the callback
    // ref guarantees this effect re-runs at that mount.
    if (!containerEl) {
      return
    }
    containerEl.addEventListener('keydown', handleKeyDown)
    return () => containerEl.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown, containerEl])

  // Why: return a stable callback ref so the caller can spread it onto the
  // container's `ref` prop. useState's setter identity is stable across
  // renders, so this doesn't churn React's ref-assignment cycle.
  return setContainerEl
}
