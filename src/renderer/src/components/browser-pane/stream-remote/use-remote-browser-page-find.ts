import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react'
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

/** The find bar's target for a page searched on its host: steps run in order, as Enter presses do locally. */
export function createRemoteBrowserFindTarget(send: RemoteFindSend): BrowserFindTarget {
  const listeners = new Set<(event: BrowserFindResultEvent) => void>()
  let lastRequestId = 0
  let searching = false
  let pending: Promise<unknown> = Promise.resolve()
  const enqueue = (step: () => Promise<unknown>): void => {
    pending = pending.then(step, step)
  }
  return {
    findInPage(text, options = {}) {
      const requestId = ++lastRequestId
      searching = true
      enqueue(async () => {
        const result = await send('browser.findInPage', {
          text,
          forward: options.forward,
          findNext: options.findNext
        })
        if (result) {
          for (const listener of listeners) {
            listener({ result: { requestId, ...result } })
          }
        }
      })
      return requestId
    },
    stopFindInPage() {
      // The bar stops on mount and on close; only a page that was searched has anything to clear.
      if (!searching) {
        return
      }
      searching = false
      enqueue(() => send('browser.stopFindInPage', {}))
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
      if (!target || !pageId || !token) {
        return null
      }
      try {
        const result = await callRuntimeRpc<BrowserFindInPageResult>(
          target,
          method,
          { worktree: runtimeWorktree, page: pageId, ...params },
          { timeoutMs: 10_000, suppressFeatureInteraction: true }
        )
        return method === 'browser.findInPage' && isCurrentRemoteOperationToken(token)
          ? result
          : null
      } catch (error) {
        if (method === 'browser.findInPage' && isCurrentRemoteOperationToken(token)) {
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
