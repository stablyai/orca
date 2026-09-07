import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceView } from '../../../../shared/window-pane-types'
import type { WorkspaceViewController } from '../../../../shared/workspace-view-control'
import type { WorkspaceViewPacket } from './workspace-view-packet'
import { sameWorkspaceSession } from '@/store/slices/window-pane-selection'
import { installWorkspacePtyControlReader } from './workspace-pty-control'
import {
  installWorkspaceBrowserControlReader,
  revokeWorkspaceBrowserInput
} from './workspace-browser-control'

let windowId = 0
let revision = 0
let controllers: Record<string, WorkspaceViewController> = {}
const keys = new Map<string, string>()
const ptyKeys = new Map<string, string>()
const browserKeys = new Map<string, string>()
const localControllers = new Map<string, string>()
const listeners = new Set<() => void>()
const notify = (): void => {
  revision++
  for (const listener of listeners) {
    listener()
  }
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWorkspaceViewControlRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  )
}

export function registerWorkspaceViewControl(
  id: number,
  packet: WorkspaceViewPacket
): { key: string; viewId: string }[] {
  windowId = id
  keys.clear()
  const entries = packet.views.map(({ view, owner, session }) => {
    const key = JSON.stringify([owner, view.worktreeId, view.contentType, session])
    keys.set(view.id, key)
    const state = useAppStore.getState()
    const terminal = state.tabsByWorktree[view.worktreeId]?.find((tab) => tab.id === view.entityId)
    if (terminal?.ptyId) {
      ptyKeys.set(terminal.ptyId, key)
    }
    for (const ptyId of Object.values(
      state.terminalLayoutsByTabId[view.entityId]?.ptyIdsByLeafId ?? {}
    )) {
      ptyKeys.set(ptyId, key)
    }
    if (view.contentType === 'browser') {
      browserKeys.set(view.entityId, key)
      for (const page of state.browserPagesByWorkspace[view.entityId] ?? []) {
        browserKeys.set(page.id, key)
      }
    }
    return { key, viewId: view.id }
  })
  notify()
  return entries
}

export function receiveWorkspaceViewControllers(
  next: Record<string, WorkspaceViewController>
): void {
  controllers = next
  revokeWorkspaceBrowserInput()
  notify()
}

export function isWorkspaceViewController(view: WorkspaceView): boolean {
  const key = keys.get(view.id)
  const controller = key && controllers[key]
  if (controller) {
    return controller.windowId === windowId && controller.viewId === view.id
  }
  if (view.controlPending || window.orcaWorkspaceViews || window.orcaWorkspaceWindowNative) {
    return false
  }
  const layout = useAppStore.getState().windowPaneLayout
  const session = JSON.stringify([
    view.executionHostId,
    view.worktreeId,
    view.contentType,
    view.entityId
  ])
  const local = localControllers.get(session)
  return local && layout?.views[local]
    ? local === view.id
    : Object.values(layout?.views ?? {}).find((other) => sameWorkspaceSession(other, view))?.id ===
        view.id
}

export async function takeWorkspaceViewControl(view: WorkspaceView): Promise<void> {
  const key = keys.get(view.id)
  if (key && window.orcaWorkspaceViews) {
    await window.orcaWorkspaceViews.claim(key, view.id)
  } else {
    localControllers.set(
      JSON.stringify([view.executionHostId, view.worktreeId, view.contentType, view.entityId]),
      view.id
    )
    notify()
  }
}

function canControlWorkspacePty(ptyId: string | null): boolean {
  if (!ptyId) {
    return true
  }
  const state = useAppStore.getState()
  const key = ptyKeys.get(ptyId)
  if (key && controllers[key] && controllers[key].windowId !== windowId) {
    return false
  }
  const tabs = Object.values(state.tabsByWorktree)
    .flat()
    .filter(
      (tab) =>
        tab.ptyId === ptyId ||
        Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).includes(ptyId)
    )
  const views = Object.values(state.windowPaneLayout?.views ?? {}).filter(
    (view) =>
      view.contentType === 'terminal' &&
      tabs.some((tab) => tab.id === view.entityId && tab.worktreeId === view.worktreeId)
  )
  return !views.length || views.some(isWorkspaceViewController)
}
installWorkspacePtyControlReader(canControlWorkspacePty)

installWorkspaceBrowserControlReader((pageId) => {
  const key = browserKeys.get(pageId)
  if (key && controllers[key] && controllers[key].windowId !== windowId) {
    return false
  }
  const state = useAppStore.getState()
  const views = Object.values(state.windowPaneLayout?.views ?? {}).filter(
    (view) =>
      view.contentType === 'browser' &&
      (view.entityId === pageId ||
        state.browserPagesByWorkspace[view.entityId]?.some((page) => page.id === pageId))
  )
  return !views.length || views.some(isWorkspaceViewController)
})
