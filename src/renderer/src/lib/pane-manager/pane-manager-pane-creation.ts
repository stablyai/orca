import type { ManagedPane, ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import type { PaneManagerHost } from './pane-manager-host'
import { applyPaneOpacity } from './pane-divider'
import { createPaneDOM, openTerminal } from './pane-lifecycle'
import { shouldFollowMouseFocus } from './focus-follows-mouse'
import { toPublicPane } from './pane-public-view'

export function createInitialManagedPane(
  host: PaneManagerHost,
  opts?: { focus?: boolean; leafId?: string }
): ManagedPane {
  const pane = host.createPaneInternal(opts?.leafId)
  Object.assign(pane.container.style, {
    width: '100%',
    height: '100%',
    position: 'relative',
    overflow: 'hidden'
  })
  host.root.appendChild(pane.container)
  openTerminal(pane)
  host.setActivePaneId(pane.id)
  applyPaneOpacity(host.panes.values(), host.getActivePaneId(), host.getStyleOptions())

  if (opts?.focus !== false) {
    pane.terminal.focus()
  }

  host.publishPaneCreated(pane)
  return toPublicPane(pane)
}

export function createManagedPaneInternal(
  host: PaneManagerHost,
  leafIdHint?: string
): ManagedPaneInternal {
  const id = host.allocatePaneId()
  const leafId = host.identities.claimLeafId(leafIdHint)
  const pane = createPaneDOM(
    id,
    leafId,
    host.options,
    host.dragState,
    host.getDragCallbacks(),
    // Why: always re-focus even if already active — after splits the
    // browser's real textarea focus can lag the manager's activePaneId.
    (paneId, options) => {
      if (!host.isDestroyed()) {
        host.setActivePane(paneId, { focus: options?.focusTerminal !== false })
      }
    },
    (paneId, event) => {
      handleManagedPaneMouseEnter(host, paneId, event)
    }
  )
  pane.webglAttachmentDeferred = host.isRenderingSuspended()
  host.panes.set(id, pane)
  host.identities.register(id, leafId)
  return pane
}

export function publishManagedPaneCreated(
  host: PaneManagerHost,
  pane: ManagedPaneInternal,
  spawnHints?: Parameters<NonNullable<PaneManagerOptions['onPaneCreated']>>[1]
): void {
  // Why: onPaneCreated wires PTY/status identity synchronously. After this
  // point, replacing the leaf id would fork ORCA_PANE_KEY from layout state.
  host.identities.markPublished(pane.id)
  void host.options.onPaneCreated?.(toPublicPane(pane), spawnHints)
}

function handleManagedPaneMouseEnter(
  host: PaneManagerHost,
  paneId: number,
  event: MouseEvent
): void {
  if (
    shouldFollowMouseFocus({
      featureEnabled: host.getStyleOptions().focusFollowsMouse ?? false,
      activePaneId: host.getActivePaneId(),
      hoveredPaneId: paneId,
      mouseButtons: event.buttons,
      windowHasFocus: document.hasFocus(),
      managerDestroyed: host.isDestroyed()
    })
  ) {
    host.setActivePane(paneId, { focus: true })
  }
}
