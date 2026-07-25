import React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import {
  pinnedTerminalPanelCanvasWorktreeId,
  resolvePinnedTerminalPanelSshTargetIdFromLabels
} from '../../../../shared/pinned-terminal-panels'
import {
  isPanelCanvasLeaf,
  type PanelCanvasLeaf,
  type PanelCanvasNode,
  type PanelCanvasPanelLeaf,
  type PanelCanvasSplit
} from '@/lib/panel-canvas'
import { buildSplitCandidates, type PanelSplitChoice } from '@/lib/panel-split-candidates'
import { translate } from '@/i18n/i18n'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { ensurePinnedWebPanelWebview } from '@/components/pinned-web-panels/pinned-web-panel-webview'
import { CANVAS_BROWSER_PARTITION } from '../../../../shared/pinned-web-panels'
import { CanvasTileChrome, canvasWebviewId } from './CanvasTileChrome'
import { SlimTerminalTile } from './SlimTerminalTile'

export { canvasWebviewId }

export type CanvasTreeCallbacks = {
  splitDisabled: boolean
  onSplitLeaf: (leafId: string, direction: 'row' | 'column', choice: PanelSplitChoice) => void
  onRemoveLeaf: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  /** Popout windows swap the tab/PTY-backed tile for their slim direct-PTY
   *  terminal; the main window omits this and gets CanvasTerminalTile.
   *  Shell tiles always use the slim terminal, in every window. */
  renderTerminalTile?: (
    leaf: PanelCanvasPanelLeaf,
    panel: PinnedTerminalPanel,
    visible: boolean
  ) => React.ReactNode
}

function splitItemsForLeaf(
  leaf: PanelCanvasLeaf,
  terminalPanels: readonly PinnedTerminalPanel[],
  webPanels: readonly PinnedWebPanel[]
) {
  return buildSplitCandidates({
    source: leaf,
    terminalPanels,
    webPanels,
    includeDuplicate: true
  })
}

function CanvasTerminalTile({
  leaf,
  panel,
  visible
}: {
  leaf: PanelCanvasPanelLeaf
  panel: PinnedTerminalPanel
  visible: boolean
}): React.JSX.Element {
  const worktreeId = pinnedTerminalPanelCanvasWorktreeId(panel.id, leaf.id)
  const tab = useAppStore((s) => (s.tabsByWorktree[worktreeId] ?? [])[0])

  // Why: mirrors PinnedTerminalPanelPage — the tab/PTY is created on first
  // mount (adopting a survivor from session restore), and an unresolvable
  // host must not fall back to running the command locally.
  React.useEffect(() => {
    const state = useAppStore.getState()
    if ((state.tabsByWorktree[worktreeId] ?? []).length > 0) {
      return
    }
    if (
      panel.host !== undefined &&
      resolvePinnedTerminalPanelSshTargetIdFromLabels(state.sshTargetLabels, panel.host) === null
    ) {
      console.warn(
        `[panel-canvas] host "${panel.host}" matches no SSH target; refusing local fallback`
      )
      return
    }
    const created = state.createTab(worktreeId, undefined, undefined, {
      activate: false,
      quickCommandLabel: panel.title
    })
    state.queueTabStartupCommand(created.id, { command: panel.command })
  }, [worktreeId, panel.host, panel.title, panel.command])

  const releaseTab = React.useCallback(
    (tabId: string) => {
      const state = useAppStore.getState()
      if ((state.tabsByWorktree[worktreeId] ?? []).some((t) => t.id === tabId)) {
        state.closeTab(tabId, { reason: 'cleanup' })
      }
    },
    [worktreeId]
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {tab ? (
        <TerminalPane
          tabId={tab.id}
          worktreeId={worktreeId}
          isActive={visible}
          isVisible={visible}
          showSplitButton={false}
          onPtyExit={() => releaseTab(tab.id)}
          onCloseTab={() => releaseTab(tab.id)}
        />
      ) : null}
    </div>
  )
}

function CanvasWebTile({
  leaf,
  panel
}: {
  leaf: PanelCanvasPanelLeaf
  panel: PinnedWebPanel
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (containerRef.current) {
      ensurePinnedWebPanelWebview({
        panelId: canvasWebviewId(leaf.id),
        url: panel.url,
        container: containerRef.current
      })
    }
  }, [leaf.id, panel.url])
  return <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" />
}

function CanvasBrowserTile({ leafId, url }: { leafId: string; url: string }): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (containerRef.current) {
      ensurePinnedWebPanelWebview({
        panelId: canvasWebviewId(leafId),
        url,
        container: containerRef.current,
        partition: CANVAS_BROWSER_PARTITION
      })
    }
  }, [leafId, url])
  return <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" />
}

export function CanvasNodeView({
  node,
  visible,
  terminalPanels,
  webPanels,
  callbacks
}: {
  node: PanelCanvasNode
  visible: boolean
  terminalPanels: readonly PinnedTerminalPanel[]
  webPanels: readonly PinnedWebPanel[]
  callbacks: CanvasTreeCallbacks
}): React.JSX.Element {
  if (isPanelCanvasLeaf(node)) {
    const splitItems = splitItemsForLeaf(node, terminalPanels, webPanels)
    const onPickSplit = (direction: 'row' | 'column', choice: PanelSplitChoice): void => {
      callbacks.onSplitLeaf(node.id, direction, choice)
    }
    if (node.kind === 'shell') {
      const label =
        node.label ??
        node.host ??
        translate('auto.components.panel-canvas.PanelCanvasTree.localShell', 'Local shell')
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
          <CanvasTileChrome
            title={label}
            host={node.host ?? undefined}
            splitItems={splitItems}
            splitDisabled={callbacks.splitDisabled}
            onPickSplit={onPickSplit}
            onClose={() => callbacks.onRemoveLeaf(node.id)}
          />
          {/* Why: shells always use the slim direct-PTY terminal, in every
              window — they are ad-hoc sessions with no pinned-panel entry,
              tab, or scrollback restore to preserve. Lifespan: ephemeral. */}
          <SlimTerminalTile spawnKey={node.id} host={node.host} command="" />
        </div>
      )
    }
    if (node.kind === 'browser') {
      const url = node.url && node.url.length > 0 ? node.url : 'about:blank'
      const title =
        node.label ??
        translate('auto.components.panel-canvas.PanelCanvasTree.blankBrowser', 'Blank browser')
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
          <CanvasTileChrome
            title={title}
            webviewLeafId={node.id}
            splitItems={splitItems}
            splitDisabled={callbacks.splitDisabled}
            onPickSplit={onPickSplit}
            onClose={() => callbacks.onRemoveLeaf(node.id)}
          />
          <CanvasBrowserTile leafId={node.id} url={url} />
        </div>
      )
    }
    const terminalPanel =
      node.kind === 'terminal' ? terminalPanels.find((p) => p.id === node.panelId) : undefined
    const webPanel = node.kind === 'web' ? webPanels.find((p) => p.id === node.panelId) : undefined
    const title =
      terminalPanel?.title ??
      webPanel?.title ??
      translate('auto.components.panel-canvas.PanelCanvasPage.missingPanel', 'Panel removed')
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
        <CanvasTileChrome
          title={title}
          host={terminalPanel?.host}
          webviewLeafId={webPanel ? node.id : undefined}
          splitItems={splitItems}
          splitDisabled={callbacks.splitDisabled}
          onPickSplit={onPickSplit}
          onClose={() => callbacks.onRemoveLeaf(node.id)}
        />
        {terminalPanel ? (
          callbacks.renderTerminalTile ? (
            callbacks.renderTerminalTile(node, terminalPanel, visible)
          ) : (
            <CanvasTerminalTile leaf={node} panel={terminalPanel} visible={visible} />
          )
        ) : webPanel ? (
          <CanvasWebTile leaf={node} panel={webPanel} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
            {translate(
              'auto.components.panel-canvas.PanelCanvasPage.missingPanelBody',
              'This pinned panel was deleted in Settings.'
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <CanvasSplitView
      split={node}
      visible={visible}
      terminalPanels={terminalPanels}
      webPanels={webPanels}
      callbacks={callbacks}
    />
  )
}

function CanvasSplitView({
  split,
  visible,
  terminalPanels,
  webPanels,
  callbacks
}: {
  split: PanelCanvasSplit
  visible: boolean
  terminalPanels: readonly PinnedTerminalPanel[]
  webPanels: readonly PinnedWebPanel[]
  callbacks: CanvasTreeCallbacks
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const isRow = split.direction === 'row'
  const sizes =
    split.sizes && split.sizes.length === split.children.length
      ? split.sizes
      : split.children.map(() => 1)

  const onDividerPointerDown = (index: number, event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) {
      return
    }
    event.preventDefault()
    const startPos = isRow ? event.clientX : event.clientY
    const rect = container.getBoundingClientRect()
    const containerSpan = isRow ? rect.width : rect.height
    if (containerSpan <= 0) {
      return
    }
    const startSizes = [...sizes]
    const total = startSizes.reduce((sum, size) => sum + size, 0)
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent): void => {
      const deltaWeight =
        (((isRow ? move.clientX : move.clientY) - startPos) / containerSpan) * total
      // Why: a drag trades weight between the divider's two neighbors only, so
      // tiles elsewhere in the split hold still; a 5% floor keeps both
      // neighbors grabbable for the reverse drag.
      const floor = total * 0.05
      const pairTotal = startSizes[index] + startSizes[index + 1]
      const left = Math.min(Math.max(startSizes[index] + deltaWeight, floor), pairTotal - floor)
      const next = [...startSizes]
      next[index] = left
      next[index + 1] = pairTotal - left
      callbacks.onResizeSplit(split.id, next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0 flex-1', isRow ? 'flex-row' : 'flex-col')}
    >
      {split.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index > 0 ? (
            <div
              role="separator"
              aria-orientation={isRow ? 'vertical' : 'horizontal'}
              onPointerDown={(event) => onDividerPointerDown(index - 1, event)}
              className={cn(
                'shrink-0 bg-transparent transition-colors hover:bg-border',
                isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
              )}
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0"
            style={{ flexGrow: sizes[index], flexBasis: 0, flexShrink: 1 }}
          >
            <CanvasNodeView
              node={child}
              visible={visible}
              terminalPanels={terminalPanels}
              webPanels={webPanels}
              callbacks={callbacks}
            />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}
