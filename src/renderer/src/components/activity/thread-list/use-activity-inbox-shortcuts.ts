import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { textFieldClaimsActionKey } from '@/lib/keyboard/text-field-shortcut-policy'
import { isNativeChatPromptTarget } from '@/lib/text-input/focus/editable-target'
import { showTerminalShortcutCaptureNotification } from '@/lib/notifications/terminal-shortcut-capture-notification'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import {
  keybindingMatchesAction,
  matchKeybindingDigitIndex
} from '../../../../../shared/keybindings/matching'
import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import { getKeybindingContext } from '../../terminal/workbench/terminal-workspace-model'
import { clearCompletedActivity, isClearableActivityThread } from './activity-clear-completed'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { useActivityThreadSelection } from './use-activity-thread-selection'
import { ACTIVITY_INDEX_ACTION_ID, useActivityIndexHints } from './use-activity-index-hints'
import type { ActivityIndexHintViewport } from './use-activity-index-hints'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ActivityGroupBy } from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'

const PLAIN_CLICK = { metaKey: false, ctrlKey: false, shiftKey: false }
// Long enough for the selection to re-render, short enough that a later status reorder cannot scroll.
const KEYBOARD_SCROLL_WINDOW_MS = 1000

type ActivityInboxAction = 'next' | 'previous' | 'clearAndNext'

const ACTION_IDS: readonly [ActivityInboxAction, KeybindingActionId][] = [
  ['next', 'activity.nextThread'],
  ['previous', 'activity.previousThread'],
  ['clearAndNext', 'activity.clearAndNext']
]

/** Neighbor in render order, wrapping at both ends; with no rendered selection, next starts at the top and previous at the bottom. */
export function resolveActivityNeighborThread(
  renderedThreads: readonly AgentPaneThread[],
  selectedPaneKey: string | null,
  direction: 'next' | 'previous'
): AgentPaneThread | null {
  const index = renderedThreads.findIndex((thread) => thread.paneKey === selectedPaneKey)
  if (index === -1) {
    return (direction === 'next' ? renderedThreads[0] : renderedThreads.at(-1)) ?? null
  }
  const step = direction === 'next' ? 1 : -1
  return renderedThreads[(index + step + renderedThreads.length) % renderedThreads.length] ?? null
}

/** Row taking the handled rows' place: the first one below them, else the nearest one above. */
export function resolveActivityThreadAfterRemoval(
  renderedThreads: readonly AgentPaneThread[],
  removedPaneKeys: ReadonlySet<string>
): AgentPaneThread | null {
  let lastRemovedIndex = -1
  renderedThreads.forEach((thread, index) => {
    if (removedPaneKeys.has(thread.paneKey)) {
      lastRemovedIndex = index
    }
  })
  const below = renderedThreads
    .slice(lastRemovedIndex + 1)
    .find((thread) => !removedPaneKeys.has(thread.paneKey))
  if (below) {
    return below
  }
  return (
    renderedThreads
      .slice(0, Math.max(lastRemovedIndex, 0))
      .findLast((thread) => !removedPaneKeys.has(thread.paneKey)) ?? null
  )
}

/** Inbox triage chords that also fire from the terminal the selection focuses. */
export function useActivityInboxShortcuts({
  onDeselect,
  selection,
  selectedPaneKey,
  selectedItemIndex,
  virtualItems,
  virtualizer,
  groupBy,
  onMarkThreadsRead
}: {
  /** Enables the shortcuts; runs when the last row is cleared. */
  onDeselect: (() => void) | undefined
  selection: Pick<
    ReturnType<typeof useActivityThreadSelection>,
    'renderedThreads' | 'selectedThreads' | 'handleSelectThread'
  >
  selectedPaneKey: string | null
  selectedItemIndex: number | null
  virtualItems: ActivityIndexHintViewport['virtualItems']
  virtualizer: Pick<
    Virtualizer<HTMLDivElement, Element>,
    'getVirtualItems' | 'scrollOffset' | 'scrollRect' | 'scrollToIndex'
  >
  groupBy: ActivityGroupBy
  onMarkThreadsRead: (threads: readonly AgentPaneThread[]) => void
}): ReadonlyMap<string, number> | null {
  const enabled = onDeselect !== undefined
  const { indexHintThreads, hintNumberByPaneKey } = useActivityIndexHints(enabled, {
    virtualItems,
    virtualRows: virtualizer.getVirtualItems(),
    scrollOffset: virtualizer.scrollOffset ?? 0,
    viewportHeight: virtualizer.scrollRect?.height ?? null,
    stickyHeaders: groupBy !== 'none'
  })
  const { scrollToIndex } = virtualizer
  // Keep one listener per mount; status pings re-render the list constantly.
  const latest = { selection, selectedPaneKey, indexHintThreads, onMarkThreadsRead, onDeselect }
  const latestRef = useRef(latest)
  useEffect(() => {
    latestRef.current = latest
  })

  // Only keyboard moves scroll; status-driven reorders must not yank the list under the pointer.
  const keyboardSelectedAtRef = useRef(0)
  useEffect(() => {
    if (
      selectedItemIndex === null ||
      Date.now() - keyboardSelectedAtRef.current > KEYBOARD_SCROLL_WINDOW_MS
    ) {
      return
    }
    keyboardSelectedAtRef.current = 0
    scrollToIndex(selectedItemIndex, { align: 'auto' })
  }, [scrollToIndex, selectedItemIndex])
  // Sidebar selection follows pane focus, which some rows never take (closed tabs, floating panel); anchor on the row the keyboard chose until focus moves.
  const keyboardAnchorRef = useRef<{ paneKey: string; focusedBefore: string | null } | null>(null)
  // Once focus moves, a later return to focusedBefore is the user's choice, not a stale keyboard move.
  useEffect(() => {
    if (keyboardAnchorRef.current?.focusedBefore !== selectedPaneKey) {
      keyboardAnchorRef.current = null
    }
  }, [selectedPaneKey])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const resolveAnchor = (): string | null => {
      const { selectedPaneKey, selection } = latestRef.current
      const anchor = keyboardAnchorRef.current
      const anchorRendered = selection.renderedThreads.some((t) => t.paneKey === anchor?.paneKey)
      return anchor && anchorRendered && anchor.focusedBefore === selectedPaneKey
        ? anchor.paneKey
        : selectedPaneKey
    }
    const select = (thread: AgentPaneThread | null): void => {
      const latest = latestRef.current
      if (!thread) {
        keyboardAnchorRef.current = null
        latest.onDeselect?.()
        return
      }
      keyboardAnchorRef.current = { paneKey: thread.paneKey, focusedBefore: latest.selectedPaneKey }
      keyboardSelectedAtRef.current = Date.now()
      // A plain click replaces any multi-selection and opens the thread.
      latest.selection.handleSelectThread(thread, PLAIN_CLICK)
    }
    const clearAndNext = (): void => {
      const latest = latestRef.current
      const { renderedThreads, selectedThreads } = latest.selection
      const anchor = resolveAnchor()
      const current = renderedThreads.find((thread) => thread.paneKey === anchor)
      const targets = selectedThreads.length > 1 ? selectedThreads : current ? [current] : []
      if (targets.length === 0) {
        return
      }
      const clearable = targets.filter(isClearableActivityThread)
      // Live or waiting agents cannot leave the list; reading them still moves the inbox forward.
      const retained = targets.filter((thread) => !isClearableActivityThread(thread))
      const next = resolveActivityThreadAfterRemoval(
        renderedThreads,
        new Set(targets.map((thread) => thread.paneKey))
      )
      clearCompletedActivity(clearable)
      if (retained.length > 0) {
        latest.onMarkThreadsRead(retained)
      }
      // Retained rows stay listed, so keep one selected rather than emptying the detail pane.
      select(next ?? retained[0] ?? null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        useAppStore.getState().activeModal !== 'none' ||
        hasVisibleOverlay() ||
        (event.target instanceof Element && event.target.closest('[data-shortcut-recorder-active]'))
      ) {
        return
      }
      const { keybindings, settings } = useAppStore.getState()
      const platform = getShortcutPlatform()
      const options = {
        context: getKeybindingContext(event.target),
        terminalShortcutPolicy: settings?.terminalShortcutPolicy
      }
      const hintIndex = matchKeybindingDigitIndex(
        ACTIVITY_INDEX_ACTION_ID,
        event,
        platform,
        keybindings,
        options
      )
      const actionId =
        hintIndex !== null
          ? ACTIVITY_INDEX_ACTION_ID
          : ACTION_IDS.find(([, id]) =>
              keybindingMatchesAction(id, event, platform, keybindings, options)
            )?.[1]
      // A selected chat agent focuses its composer; these chords must keep moving the inbox from there.
      if (
        !actionId ||
        (!isNativeChatPromptTarget(event.target) && textFieldClaimsActionKey(event, actionId))
      ) {
        return
      }
      event.preventDefault()
      // Keep the chord out of the focused terminal's PTY.
      event.stopPropagation()
      if (options.context === 'terminal') {
        showTerminalShortcutCaptureNotification({ actionId, platform, keybindings })
      }
      // Each selection activates a workspace and may revive SSH tabs; a held chord must not sweep through them.
      if (event.repeat) {
        return
      }
      const latest = latestRef.current
      if (hintIndex !== null) {
        const thread = latest.indexHintThreads[hintIndex]
        if (thread) {
          select(thread)
        }
        return
      }
      const action = ACTION_IDS.find(([, id]) => id === actionId)?.[0]
      if (action === 'clearAndNext') {
        clearAndNext()
        return
      }
      if (!action) {
        return
      }
      const neighbor = resolveActivityNeighborThread(
        latest.selection.renderedThreads,
        resolveAnchor(),
        action
      )
      if (neighbor) {
        select(neighbor)
      }
    }
    // A click picks its own row even when focus does not move (clicking the still-focused pane).
    const dropAnchor = (): void => {
      keyboardAnchorRef.current = null
    }
    addAppKeyListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', dropAnchor, true)
    return () => {
      removeAppKeyListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', dropAnchor, true)
    }
  }, [enabled])
  return hintNumberByPaneKey
}
