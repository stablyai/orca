import type { WorkspaceViewRegistration } from './workspace-view-control'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { WorkspacePaneDropTarget, WorkspaceView } from './window-pane-types'
export type WorkspaceViewPlacement = {
  windowId: number
  epoch: number
  windowTitle: string
  paneId: string
  paneNumber: number
  view: WorkspaceView
  projectName: string
  workspace: string
  hostName: string
  availability: string
  owner?: string
  session?: string
}
export type WorkspaceViewLocation = Pick<
  WorkspaceViewPlacement,
  'windowId' | 'epoch' | 'paneId'
> & { viewId: string }
export type WorkspaceViewCommand =
  | 'prepare-undo-transfer'
  | 'undo-transfer'
  | 'bring-monitor'
  | 'undo-layout'
  | 'reopen-view'
  | 'discover'
  | 'visit'
  | 'capture'
  | 'import'
  | 'remove'
  | 'restore'
  | 'rollback'
  | 'finish'
  | 'controllers'
  | 'drop-target'
export type WorkspaceViewBridge = {
  undoTransfer: (id: string) => Promise<boolean>
  monitors: () => Promise<{ id: number; label: string }[]>
  moveToMonitor: (id: number) => Promise<boolean>
  bringWindowsToMonitor: () => Promise<void>
  tileWindowsOnMonitor: () => Promise<number>
  distributeWindowsAcrossMonitors: () => Promise<number>
  showMonitorMenu: () => Promise<void>
  reopenWindow: () => Promise<number>
  discover: () => Promise<WorkspaceViewPlacement[]>
  visit: (location: WorkspaceViewLocation) => Promise<boolean>
  open: (location: WorkspaceViewLocation, target: WorkspacePaneDropTarget) => Promise<boolean>
  createWindow: () => Promise<number>
  locateDrop: (point: { x: number; y: number }) => Promise<{
    destinationId: number
    title: string
    target: WorkspacePaneDropTarget
    label: string
  } | null>
  ready: () => Promise<number>
  registerViews: (views: WorkspaceViewRegistration[]) => Promise<void>
  claim: (key: string, viewId: string) => Promise<boolean>
  subscribeBrowser: (
    request: {
      runtimeId: string | null
      environmentId?: string
      expectedEnvironmentPairingRevision?: number
      params: unknown
    },
    callbacks: {
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
      onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
      onError?: (error: { code: string; message: string }) => void
      onClose?: () => void
    }
  ) => Promise<{
    unsubscribe: () => void
    sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null>
  list: () => Promise<{ id: number; title: string }[]>
  transfer: (request: {
    destinationId: number
    viewIds?: string[]
    mode: 'tabs' | 'panes'
    duplicate?: boolean
    target?: WorkspacePaneDropTarget
  }) => Promise<boolean>
  onRequest: (
    callback: (operation: WorkspaceViewCommand, payload: unknown) => Promise<unknown>
  ) => () => void
}
