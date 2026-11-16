import { focusPanePreservingOverlays } from './pane-focus/pane-overlay-focus'
import type {
  ManagedPane,
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneActivationOptions
} from './pane-manager-types'
import type { PaneManagerHost } from './pane-manager-host'
import {
  applyPaneOpacity,
  applyDividerStyles,
  applyRootBackground
} from './pane-layout/pane-divider'
import { openTerminal } from './pane-lifecycle'
import { createPaneDOM } from '@/lib/pane-manager/pane-dom-creation'
import { shouldFollowMouseFocus } from './pane-focus/focus-follows-mouse'
import { toPublicPane } from './pane-public-view'

export function applyManagedPaneStyles(host: PaneManagerHost): void {
  applyPaneOpacity(host.panes.values(), host.getActivePaneId(), host.getStyleOptions())
  applyDividerStyles(host.root, host.getStyleOptions())
  applyRootBackground(host.root, host.getStyleOptions())
}

export function activateManagedPane(
  host: PaneManagerHost,
  pane: ManagedPaneInternal,
  opts?: PaneActivationOptions
): void {
  const changed = host.getActivePaneId() !== pane.id
  host.setActivePaneId(pane.id)
  applyPaneOpacity(host.panes.values(), host.getActivePaneId(), host.getStyleOptions())

  if (opts?.focus !== false) {
    focusPanePreservingOverlays(pane)
  }

  if (changed) {
    host.options.onActivePaneChange?.(toPublicPane(pane))
  }
}

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
  openTerminal(pane, {
    ligatures: host.options.terminalLigaturesEnabled?.(),
    inlineImages: host.options.terminalInlineImagesEnabled?.()
  })
  host.setActivePaneId(pane.id)
  applyPaneOpacity(host.panes.values(), host.getActivePaneId(), host.getStyleOptions())

  if (opts?.focus !== false) {
    focusPanePreservingOverlays(pane)
  }

  host.publishPaneCreated(pane, { placement: { kind: 'new-tab' } })
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
    // Refocus even when already active: browser textarea focus can lag activePaneId after splits.
    (paneId, options) => {
      if (!host.isDestroyed()) {
        host.setActivePane(paneId, {
          focus: options?.focusTerminal !== false
        })
      }
    },
    (paneId, event) => {
      handleManagedPaneMouseEnter(host, paneId, event)
    }
  )
  // A pane mounted behind a hidden surface defers WebGL, so its DOM blink stays focus-gated and needs no suspension.
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
  // onPaneCreated binds PTY/status identity synchronously; later leaf replacement would fork ORCA_PANE_KEY from layout state.
  host.identities.markPublished(pane.id)
  void host.options.onPaneCreated?.(toPublicPane(pane), spawnHints)
}

function handleManagedPaneMouseEnter(
  host: PaneManagerHost,
  paneId: number,
  event: MouseEvent
): void {
  const pane = host.panes.get(paneId)
  if (!pane) {
    return
  }
  const focusedPane = document.activeElement?.closest('.pane[data-pane-id]')
  if (
    shouldFollowMouseFocus({
      featureEnabled: host.getStyleOptions().focusFollowsMouse ?? false,
      activePaneId: host.getActivePaneId(),
      hoveredPaneId: paneId,
      focusInOtherPane: focusedPane != null && focusedPane !== pane.container,
      mouseButtons: event.buttons,
      windowHasFocus: document.hasFocus(),
      managerDestroyed: host.isDestroyed()
    })
  ) {
    host.setActivePane(paneId, { focus: true })
  }
}
