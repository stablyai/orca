import React, { useEffect, useMemo, useRef } from 'react'
import {
  FRAME_EVENTS,
  PLUGIN_PANEL_FRAME_NAME_PREFIX
} from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import { usePluginSidebarBackdrop, type ActivePluginSidebarBackdrop } from '@/store/plugin-panels'
import { fillPluginPanelShell } from '../right-sidebar/plugin-panel-design-token-css'
import { usePluginFrameEntry } from '../right-sidebar/use-plugin-frame-entry'
import { usePluginFrameHost } from '../right-sidebar/use-plugin-frame-host'
import { readWorktreeSidebarCards } from './worktree-sidebar-backdrop-layout'

type ContainerRef = React.RefObject<HTMLElement | null>

/** Posts the card layout to the frame on every scroll, resize, hover and status change. */
function useWorktreeSidebarCardStream(
  containerRef: ContainerRef,
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  frameKey: string | null,
  includeStatus: boolean
): void {
  useEffect(() => {
    const root = containerRef.current
    const iframe = iframeRef.current
    if (!frameKey || !root || !iframe) {
      return
    }
    const keys = new Map<string, number>()
    const keyOf = (worktreeId: string): number => {
      const key = keys.get(worktreeId) ?? keys.size
      keys.set(worktreeId, key)
      return key
    }
    let pending = 0
    let lastSent = ''
    const send = (): void => {
      pending = 0
      const layout = readWorktreeSidebarCards(root, keyOf, includeStatus)
      const serialized = JSON.stringify(layout)
      if (serialized !== lastSent) {
        lastSent = serialized
        iframe.contentWindow?.postMessage(
          pluginEvent(FRAME_EVENTS.worktreeSidebarCards, layout),
          '*'
        )
      }
    }
    const schedule = (): void => {
      pending ||= requestAnimationFrame(send)
    }
    // Why resend on load: messages posted before the srcdoc document parses are dropped.
    const onLoad = (): void => {
      lastSent = ''
      schedule()
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    const mutations = new MutationObserver(schedule)
    mutations.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'data-worktree-status', 'data-worktree-card-active']
    })
    iframe.addEventListener('load', onLoad)
    root.addEventListener('scroll', schedule, true)
    root.addEventListener('pointerover', schedule)
    root.addEventListener('pointerleave', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(pending)
      resize.disconnect()
      mutations.disconnect()
      iframe.removeEventListener('load', onLoad)
      root.removeEventListener('scroll', schedule, true)
      root.removeEventListener('pointerover', schedule)
      root.removeEventListener('pointerleave', schedule)
    }
  }, [containerRef, iframeRef, frameKey, includeStatus])
}

function BackdropFrame({
  backdrop,
  containerRef
}: {
  backdrop: ActivePluginSidebarBackdrop
  containerRef: ContainerRef
}): React.JSX.Element | null {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const { entry, markUnresponsive } = usePluginFrameEntry('panel', backdrop.pluginKey, backdrop.id)
  const html = entry.status === 'ready' ? entry.html : null
  // Why memoized: a new srcdoc reloads the frame; theme changes arrive as messages instead.
  const frameDocument = useMemo(() => (html ? fillPluginPanelShell(html) : null), [html])
  const frameKey = entry.status === 'ready' ? `${backdrop.tabKey}:${entry.revision}` : null
  const { onFrameLoad } = usePluginFrameHost({
    surface: 'panel',
    iframeRef,
    frameKey,
    sessionToken: entry.status === 'ready' ? entry.sessionToken : null,
    onUnresponsive: markUnresponsive
  })
  useWorktreeSidebarCardStream(containerRef, iframeRef, frameKey, backdrop.canReadAgents)

  // Decorative only: a failed or suspended backdrop leaves the plain sidebar.
  if (!frameDocument) {
    return null
  }
  return (
    <iframe
      key={frameKey}
      ref={iframeRef}
      // SECURITY: never add allow-same-origin — the srcdoc frame must stay an opaque origin so
      // plugin UI cannot reach the app DOM, storage, or IPC.
      sandbox="allow-scripts"
      name={`${PLUGIN_PANEL_FRAME_NAME_PREFIX}${backdrop.tabKey}`}
      srcDoc={frameDocument}
      onLoad={onFrameLoad}
      title={backdrop.title}
      aria-hidden="true"
      tabIndex={-1}
      // Why -z-10: the sidebar root isolates, so the frame paints over its background, under the cards.
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full border-0 bg-transparent"
    />
  )
}

/** A plugin frame drawn behind the workspace cards; nothing mounts unless a plugin provides one. */
export function WorktreeSidebarBackdrop({
  containerRef
}: {
  containerRef: ContainerRef
}): React.JSX.Element | null {
  const backdrop = usePluginSidebarBackdrop()
  return backdrop ? <BackdropFrame backdrop={backdrop} containerRef={containerRef} /> : null
}
