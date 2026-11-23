import { useCallback, useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { BROWSER_FIND_IN_PAGE_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { BrowserPage } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserFindInPageResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  BrowserFindResultEvent,
  BrowserFindTarget
} from '../assemble-chrome/find/browser-find-target'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

type RemoteFindSend = (
  method: 'browser.findInPage' | 'browser.stopFindInPage',
  params: { text?: string; forward?: boolean; findNext?: boolean }
) => Promise<BrowserFindInPageResult | null>

type RemoteFindStep =
  | { kind: 'find'; requestId: number; text: string; forward?: boolean; findNext?: boolean }
  | { kind: 'stop' }

/** The find bar's target for a page searched on its host, one step at a time so each Enter press is its own step. */
export function createRemoteBrowserFindTarget(send: RemoteFindSend): BrowserFindTarget {
  const listeners = new Set<(event: BrowserFindResultEvent) => void>()
  let lastRequestId = 0
  let searching = false
  let running = false
  let queue: RemoteFindStep[] = []
  const drain = async (): Promise<void> => {
    running = true
    try {
      for (let step = queue.shift(); step; step = queue.shift()) {
        if (step.kind === 'stop') {
          await send('browser.stopFindInPage', {})
          continue
        }
        const { requestId, text, forward, findNext } = step
        const result = await send('browser.findInPage', { text, forward, findNext })
        if (result) {
          for (const listener of listeners) {
            listener({ result: { requestId, ...result } })
          }
        }
      }
    } finally {
      running = false
    }
  }
  // A new search or a stop supersedes every step still waiting; a round trip each would replay old queries after the bar moved on.
  const enqueue = (step: RemoteFindStep, supersedes: boolean): void => {
    queue = supersedes ? [step] : [...queue, step]
    if (!running) {
      void drain()
    }
  }
  return {
    findInPage(text, options = {}) {
      const requestId = ++lastRequestId
      searching = true
      enqueue({ kind: 'find', requestId, text, ...options }, options.findNext === true)
      return requestId
    },
    stopFindInPage() {
      // The bar stops on mount and on close; only a page that was searched has anything to clear.
      if (!searching) {
        return
      }
      searching = false
      enqueue({ kind: 'stop' }, true)
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    }
  }
}

export type RemoteBrowserPageFind = {
  /** Null on hosts without browser.findInPage, whose panes answer Cmd+F with a notice. */
  openFind: (() => void) | null
  findOpen: boolean
  closeFind: () => void
  findTargetRef: RefObject<BrowserFindTarget | null>
  /** Escape typed in the page closes the bar and still reaches the page, as on a local page. */
  closeFindOnPageEscape: (event: KeyboardEvent) => void
}

/** Find in page for a streamed page: the local find bar, with the host's Chromium running the search. */
export function useRemoteBrowserPageFind({
  runtimeEnvironmentId,
  isActive,
  browserTab,
  lifecycle,
  runtimeTarget,
  runtimeWorktree,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  setPaneNotice
}: {
  runtimeEnvironmentId: string
  isActive: boolean
  browserTab: Pick<BrowserPage, 'loading'>
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  runtimeWorktree: string
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): RemoteBrowserPageFind {
  const supported = useRuntimeEnvironmentCapability(
    runtimeEnvironmentId,
    BROWSER_FIND_IN_PAGE_RUNTIME_CAPABILITY
  )
  const [findOpen, setFindOpen] = useState(false)
  const send = useLatestHandler<Parameters<RemoteFindSend>, ReturnType<RemoteFindSend>>(
    async (method, params) => {
      const target = runtimeTarget()
      const pageId = lifecycle.tokens.remotePage
      const token = pageId ? createRemoteOperationToken(pageId) : null
      // A stop after unmount still clears the host page; only results need a current pane.
      if (!target || !pageId || (!token && method === 'browser.findInPage')) {
        return null
      }
      try {
        const result = await callRuntimeRpc<BrowserFindInPageResult>(
          target,
          method,
          { worktree: runtimeWorktree, page: pageId, ...params },
          { timeoutMs: 10_000, suppressFeatureInteraction: true }
        )
        return token && method === 'browser.findInPage' && isCurrentRemoteOperationToken(token)
          ? result
          : null
      } catch (error) {
        if (token && method === 'browser.findInPage' && isCurrentRemoteOperationToken(token)) {
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote browser command failed.'
          })
        }
        return null
      }
    }
  )
  const [findTargetRef] = useState(() => ({ current: createRemoteBrowserFindTarget(send) }))
  // Switching tabs unmounts the pane but keeps the host page, which would keep this search's highlights.
  useEffect(() => {
    const findTarget = findTargetRef.current
    return () => findTarget.stopFindInPage('clearSelection')
  }, [findTargetRef])
  // Stable, so the pane's chord listener is not rebound on every render.
  const openFind = useCallback(() => setFindOpen(true), [])

  const { loading } = browserTab
  // A new document or a hidden pane ends the search, as a local page's navigation does.
  const [seen, setSeen] = useState({ loading, isActive })
  if (seen.loading !== loading || seen.isActive !== isActive) {
    setSeen({ loading, isActive })
    if (loading || !isActive) {
      setFindOpen(false)
    }
  }

  return {
    openFind: supported ? openFind : null,
    findOpen: supported && findOpen,
    closeFind: () => setFindOpen(false),
    findTargetRef,
    closeFindOnPageEscape: (event) => {
      if (
        findOpen &&
        event.key === 'Escape' &&
        !event.repeat &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setFindOpen(false)
      }
    }
  }
}
