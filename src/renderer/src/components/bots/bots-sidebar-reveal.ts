// "Reveal current" for the Bots section: unfold the path to the row, then scroll it into view
// and flash it once the deepest row it can reach has mounted.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
  type ScrollToCurrentWorkspaceRevealRequestDetail
} from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { revealElementInScrollContainer } from '@/components/sidebar/worktree-list/navigation/worktree-sidebar-reveal'
import { readSidebarRevealTarget } from '@/components/sidebar/sidebar-reveal-target-state'
import {
  BOTS_GROUP_KEY,
  getLineageGroupKey,
  getWorktreeLineageGroupKey
} from '../../../../shared/sidebar-list/sections/group-keys'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  botWorkerLineRowKey,
  sidebarRevealTargetKey
} from '../../../../shared/sidebar-list/sidebar-reveal-target'
import { findBotsRevealElement, wantedDepth } from './bots-sidebar-reveal-dom'
import { startBotsRevealGlow, type BotsRevealGlow } from './bots-sidebar-reveal-glow'
import type { BotsRevealContextValue, BotsRevealRequest } from './bots-sidebar-reveal-context'
import { seekDistantBotSidebarRow } from './bot-sidebar-virtual-scroll'
import { botGroupFoldToOpen } from './bot-group-folders'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'

/** Long enough for a paired server's chat read; past it, the bot row stands as the reveal. */
export const BOTS_REVEAL_MAX_WAIT_MS = 10_000

type LiveRequest = {
  request: BotsRevealRequest
  /** Deepest depth revealed so far, 0 for none. */
  revealedDepth: 0 | 1 | 2 | 3
  revealedElement: HTMLElement | null
  /** "Reveal current" glows its row; an activation's reveal only scrolls to it. */
  glow: boolean
  settled: boolean
  sought: boolean
  frames: number[]
  timers: number[]
}

/** The Bots section's side of "Reveal current": listens for the request, unfolds the path, and
 *  reveals the deepest mounted row, holding the bot row as the reveal until its chat read answers.
 *  `listShown`: the section is unfolded and has rows. `entries`: each row's home, for its fold. */
export function useBotsSidebarReveal(
  listRef: React.RefObject<HTMLDivElement | null>,
  listShown: boolean,
  entries: readonly { id: string; home: { id: string } }[],
  /** Runs as a request starts: a search hiding the list ends, so the revealed row shows. */
  beforeReveal: () => void
): BotsRevealContextValue {
  const [request, setRequest] = useState<BotsRevealRequest | null>(null)
  const live = useRef<LiveRequest | null>(null)
  const glow = useRef<BotsRevealGlow | null>(null)
  const nonceRef = useRef(0)
  const entriesRef = useRef(entries)
  const beforeRevealRef = useRef(beforeReveal)
  useLayoutEffect(() => {
    entriesRef.current = entries
    beforeRevealRef.current = beforeReveal
  })

  const stop = useCallback((entry: LiveRequest | null) => {
    if (!entry) {
      return
    }
    entry.frames.forEach((frame) => window.cancelAnimationFrame(frame))
    entry.timers.forEach((timer) => window.clearTimeout(timer))
    if (live.current === entry) {
      live.current = null
    }
  }, [])

  const finish = useCallback(
    (entry: LiveRequest) => {
      if (live.current !== entry) {
        return
      }
      const { request: finished, revealedDepth } = entry
      stop(entry)
      setRequest((current) => (current?.nonce === finished.nonce ? null : current))
      if (!finished.beginRename) {
        return
      }
      if (finished.target.worker && revealedDepth === 3) {
        const { worker } = finished.target
        useAppStore.getState().setRenamingWorktreeId({
          worktreeId: worker.id,
          rowKey: botWorkerLineRowKey(worker.identity)
        })
      } else {
        toast.info(
          translate(
            'sidebar.revealCurrent.renameUnlisted',
            'This workspace isn’t listed in the sidebar right now, so it can’t be renamed there.'
          )
        )
      }
    },
    [stop]
  )

  const reveal = useCallback(
    (entry: LiveRequest, element: HTMLElement, depth: 1 | 2 | 3) => {
      const container = listRef.current
      if (!container || live.current !== entry) {
        return
      }
      if (element !== entry.revealedElement) {
        revealElementInScrollContainer(container, element, 'smooth')
        // One glow at a time: a deeper row taking over ends the bot row's.
        glow.current?.end()
        glow.current = entry.glow
          ? startBotsRevealGlow(container, entry.request.target, depth, element)
          : null
        entry.revealedElement = element
      }
      entry.revealedDepth = depth
    },
    [listRef]
  )

  // One pass over what has mounted: the deepest row wins; the bot row waits a frame for it.
  const attempt = useCallback(
    (entry: LiveRequest, last = false) => {
      const container = listRef.current
      if (!container || live.current !== entry) {
        return
      }
      const { target } = entry.request
      if (!entry.sought && !last) {
        entry.sought = seekDistantBotSidebarRow(container, target)
      }
      const wanted = wantedDepth(target)
      if (wanted > 1) {
        const deep = findBotsRevealElement(container, target, wanted)
        if (deep) {
          reveal(entry, deep, wanted)
          // A worker line can move under a chat once the read lands; done only once it has.
          if (wanted === 2 || entry.settled) {
            finish(entry)
          }
          return
        }
      }
      if (entry.revealedDepth > 0) {
        return
      }
      const revealRow = (): void => {
        if (live.current !== entry || entry.revealedDepth > 0) {
          return
        }
        const row = findBotsRevealElement(container, target, 1)
        if (!row) {
          return
        }
        reveal(entry, row, 1)
        if (wanted === 1) {
          finish(entry)
        }
      }
      if (last) {
        revealRow()
        return
      }
      const frame = window.requestAnimationFrame(() => {
        entry.frames = entry.frames.filter((id) => id !== frame)
        revealRow()
      })
      entry.frames.push(frame)
    },
    [finish, listRef, reveal]
  )

  const settle = useCallback(
    (nonce: number) => {
      const entry = live.current
      if (!entry || entry.request.nonce !== nonce || entry.settled) {
        return
      }
      entry.settled = true
      // Two frames: a chat fold the request opens commits before the last look.
      const first = window.requestAnimationFrame(() => {
        const second = window.requestAnimationFrame(() => {
          if (live.current !== entry) {
            return
          }
          attempt(entry, true)
          finish(entry)
        })
        entry.frames.push(second)
      })
      entry.frames.push(first)
    },
    [attempt, finish]
  )

  useEffect(() => {
    const onRequest = (event: Event): void => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as ScrollToCurrentWorkspaceRevealRequestDetail | undefined)
          : undefined
      if (detail?.target?.type === 'sidebar-row') {
        return
      }
      const target = readSidebarRevealTarget()
      if (target.section !== 'bots') {
        return
      }
      beforeRevealRef.current()
      const store = useAppStore.getState()
      const toUnfold = new Set<string>([BOTS_GROUP_KEY])
      const wanted = wantedDepth(target)
      const homeId =
        entriesRef.current.find((candidate) => candidate.id === target.entryKey)?.home.id ?? null
      const groupFold = botGroupFoldToOpen(target.entryKey, readBotGroups(), store.collapsedGroups)
      if (groupFold) {
        toUnfold.add(groupFold)
      }
      if (wanted > 1 && homeId) {
        toUnfold.add(getLineageGroupKey(folderWorkspaceKey(homeId)))
      }
      if (wanted === 3) {
        for (const ancestor of target.worker?.ancestors ?? []) {
          toUnfold.add(getWorktreeLineageGroupKey(ancestor))
        }
      }
      for (const key of toUnfold) {
        if (store.collapsedGroups.has(key)) {
          store.toggleCollapsedGroup(key)
        }
      }
      stop(live.current)
      nonceRef.current += 1
      const next: BotsRevealRequest = {
        target,
        nonce: nonceRef.current,
        beginRename:
          (detail as { beginRename?: boolean } | undefined)?.beginRename === true &&
          target.worker !== undefined
      }
      const entry: LiveRequest = {
        request: next,
        revealedDepth: 0,
        revealedElement: null,
        glow: detail?.highlight !== false,
        // Nothing lists under a down host's row, and a bot-only target needs nothing below it.
        settled: wanted === 1,
        sought: false,
        frames: [],
        timers: []
      }
      live.current = entry
      entry.timers.push(
        window.setTimeout(() => {
          attempt(entry, true)
          finish(entry)
        }, BOTS_REVEAL_MAX_WAIT_MS)
      )
      setRequest(next)
    }
    window.addEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    return () => {
      window.removeEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    }
  }, [attempt, finish, stop])

  // Rows mount as folds open and reads land: look again on each change to the list.
  useEffect(() => {
    const entry = live.current
    const container = listRef.current
    if (!request || !entry || entry.request.nonce !== request.nonce || !container) {
      return
    }
    attempt(entry)
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame !== null) {
        return
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        attempt(entry)
      })
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [request, listShown, attempt, listRef])

  // What is in front moved (another workspace, tab or view): the request is stale; drop it.
  useEffect(() => {
    if (!request) {
      return
    }
    const key = sidebarRevealTargetKey(request.target)
    return useAppStore.subscribe(() => {
      const entry = live.current
      if (
        entry?.request.nonce === request.nonce &&
        sidebarRevealTargetKey(readSidebarRevealTarget()) !== key
      ) {
        stop(entry)
        setRequest((current) => (current?.nonce === request.nonce ? null : current))
      }
    })
  }, [request, stop])

  useEffect(
    () => () => {
      stop(live.current)
      glow.current?.end()
      glow.current = null
    },
    [stop]
  )

  return useMemo(() => ({ request, settle }), [request, settle])
}
