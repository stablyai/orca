import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { resolveHosts, waitForWorkspaceViewSessions } from './workspace-view-session-readiness'
import {
  captureWorkspaceViews,
  importWorkspaceViews,
  sessionIdentity,
  type WorkspaceViewPacket
} from './workspace-view-packet'
import {
  receiveWorkspaceViewControllers,
  registerWorkspaceViewControl
} from './workspace-view-control-state'
import type { WorkspaceViewController } from '../../../../shared/workspace-view-control'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { captureEditorView } from '../editor/editor-view-transfer'
import { getDiskBaselineSignature } from '../editor/diff-content-signature'
import { toVisibleTabType } from '../../../../shared/tab-types'
import { workspacePaneDropTarget } from './workspace-pane-drop-target'
import type { WorkspacePaneDropTarget } from '../../../../shared/window-pane-types'
import { projectPaneContext } from './project-pane-context'
import { WorkspaceViewTransactionHistory } from './workspace-view-transaction-history'
import { recoverWorkspaceLayout } from './workspace-layout-actions'
import { resolveWorkspaceView } from '@/store/slices/window-pane-selection'

export function useWorkspaceViewTransfer(): void {
  useEffect(() => {
    const bridge = window.orcaWorkspaceViews
    if (!bridge) {
      return
    }
    const captures = new Map<
      string,
      { packet: WorkspaceViewPacket; hosts: Record<string, string> }
    >()
    const imports = new Map<string, { previous: Partial<AppState>; imported: Partial<AppState> }>()
    const history = new WorkspaceViewTransactionHistory()
    const lifetime = new AbortController()
    const persist = async (): Promise<void> => {
      const state = useAppStore.getState()
      await window.api.session.patch(
        buildEditorSessionData(
          state.openFiles,
          state.editorDrafts,
          state.markdownFrontmatterVisible,
          state.activeFileIdByWorktree,
          state.activeTabTypeByWorktree
        )
      )
      await window.api.session.flush()
      await window.api.ui.set({ windowPaneLayout: state.windowPaneLayout })
    }
    const unsubscribe = bridge.onRequest(async (operation, raw) => {
      if (operation === 'bring-monitor') {
        await bridge.bringWindowsToMonitor()
        return true
      }
      if (operation === 'undo-layout' || operation === 'reopen-view') {
        await recoverWorkspaceLayout(operation === 'reopen-view')
        await persist()
        return true
      }
      if (operation === 'discover') {
        const hosts = await resolveHosts()
        const state = useAppStore.getState()
        const layout = state.windowPaneLayout
        return Object.values(layout?.panes ?? {}).flatMap((pane, index) =>
          pane.viewIds.map((id) => {
            const view = layout!.views[id]
            const context = projectPaneContext(state, view)
            const tab = resolveWorkspaceView(state, view)
            return {
              owner: hosts[view.executionHostId],
              session: tab ? sessionIdentity(state, tab) : undefined,
              paneId: pane.id,
              paneNumber: index + 1,
              view: { ...view, label: context.session },
              projectName: context.projectName,
              workspace: context.workspace,
              hostName: context.hostName,
              availability: context.availability
            }
          })
        )
      }
      if (operation === 'visit') {
        const { paneId, viewId } = raw as { paneId: string; viewId: string }
        const state = useAppStore.getState()
        if (!state.windowPaneLayout?.panes[paneId]?.viewIds.includes(viewId)) {
          return false
        }
        flushSync(() => {
          state.focusWindowPane(paneId, viewId)
          state.setActiveView('terminal')
        })
        return true
      }
      if (operation === 'drop-target') {
        const result = workspacePaneDropTarget(raw as { x: number; y: number })
        return result ? { target: result.target, label: result.label } : null
      }
      if (operation === 'controllers') {
        flushSync(() =>
          receiveWorkspaceViewControllers(raw as Record<string, WorkspaceViewController>)
        )
        return true
      }
      const args = raw as {
        id: string
        succeeded?: boolean
        transaction?: boolean
        paneId?: string
        viewIds?: string[]
        packet: WorkspaceViewPacket
        mode: 'tabs' | 'panes'
        target?: WorkspacePaneDropTarget
      }
      if (operation === 'prepare-undo-transfer') {
        return history.canUndo(args.id)
      }
      if (operation === 'undo-transfer') {
        if (!history.undo(args.id)) {
          return false
        }
        await persist()
        return true
      }
      if (operation === 'capture') {
        const hosts = await resolveHosts()
        const state = useAppStore.getState()
        if (
          args.paneId &&
          !args.viewIds?.every((id) =>
            state.windowPaneLayout?.panes[args.paneId!]?.viewIds.includes(id)
          )
        ) {
          throw new Error('View no longer exists in this pane')
        }
        const packet = captureWorkspaceViews(
          state,
          args.viewIds ?? Object.keys(state.windowPaneLayout?.views ?? {}),
          hosts
        )
        captures.set(args.id, { packet, hosts })
        return packet
      }
      if (operation === 'import') {
        const hosts = await waitForWorkspaceViewSessions(args.packet, lifetime.signal)
        const state = useAppStore.getState()
        const imported = importWorkspaceViews(state, args.packet, args.mode, hosts, args.target)
        const previous = Object.fromEntries(
          Object.keys(imported).map((key) => [key, state[key as keyof AppState]])
        ) as Partial<AppState>
        imports.set(args.id, { previous, imported })
        history.stage(args.id, state, imported)
        useAppStore.setState(imported)
        await persist()
        return true
      }
      if (operation === 'remove') {
        const captured = captures.get(args.id)
        if (!captured) {
          return false
        }
        const hosts = await resolveHosts()
        const current = captureWorkspaceViews(
          useAppStore.getState(),
          captured.packet.views.map((entry) => entry.view.id),
          hosts
        )
        if (JSON.stringify(current) !== JSON.stringify(captured.packet)) {
          return false
        }
        const before = useAppStore.getState()
        for (const entry of captured.packet.views) {
          useAppStore.getState().closeWorkspaceView(entry.paneId, entry.view.id, false)
        }
        history.stage(args.id, before, {
          windowPaneLayout: useAppStore.getState().windowPaneLayout
        })
        await persist()
        return true
      }
      if (operation === 'restore') {
        history.restore(args.id)
        await persist()
        return true
      }
      if (operation === 'rollback') {
        const transaction = imports.get(args.id)
        if (transaction) {
          const previousIds = new Set(
            Object.keys(transaction.previous.windowPaneLayout?.views ?? {})
          )
          for (const pane of Object.values(transaction.imported.windowPaneLayout?.panes ?? {})) {
            for (const viewId of pane.viewIds) {
              if (!previousIds.has(viewId)) {
                const state = useAppStore.getState()
                const view = transaction.imported.windowPaneLayout!.views[viewId]
                if (toVisibleTabType(view.contentType) === 'editor') {
                  const baseline = transaction.imported.editorDrafts?.[view.entityId]
                  const file = transaction.imported.openFiles?.find(
                    (file) => file.id === view.entityId
                  )
                  const live = captureEditorView(viewId)
                  if (
                    state.editorDrafts[view.entityId] !== baseline ||
                    (live &&
                      (baseline !== undefined
                        ? live.text !== baseline
                        : getDiskBaselineSignature(live.text) !== file?.lastKnownDiskSignature))
                  ) {
                    continue
                  }
                }
                state.closeWorkspaceView(pane.id, viewId, false)
              }
            }
          }
          await persist()
        }
      }
      history.finish(args.id, args.succeeded === true, args.transaction === true)
      imports.delete(args.id)
      captures.delete(args.id)
      return true
    })
    let disposed = false
    let revision = 0
    let registered = ''
    const synchronize = async (): Promise<void> => {
      if (!useAppStore.getState().workspaceSessionReady) {
        return
      }
      const generation = ++revision
      const [id, hosts] = await Promise.all([bridge.ready(), resolveHosts()])
      if (disposed || generation !== revision) {
        return
      }
      const state = useAppStore.getState()
      const ids = Object.values(state.windowPaneLayout?.views ?? {})
        .filter(
          (view) =>
            (view.contentType === 'terminal' || view.contentType === 'browser') &&
            hosts[view.executionHostId]
        )
        .map((view) => view.id)
      const packet = ids.length ? captureWorkspaceViews(state, ids, hosts) : { views: [] }
      const entries = registerWorkspaceViewControl(id, packet)
      const signature = JSON.stringify(entries)
      if (signature === registered) {
        return
      }
      registered = signature
      try {
        await bridge.registerViews(entries)
      } catch (error) {
        if (registered === signature) {
          registered = ''
        }
        throw error
      }
    }
    const schedule = (): void => {
      void synchronize().catch(() => {})
    }
    schedule()
    const stopStore = useAppStore.subscribe((state, previous) => {
      if (
        state.windowPaneLayout !== previous.windowPaneLayout ||
        state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
        state.sshConnectionStates !== previous.sshConnectionStates ||
        state.workspaceSessionReady !== previous.workspaceSessionReady
      ) {
        schedule()
      }
    })
    return () => {
      disposed = true
      lifetime.abort()
      stopStore()
      unsubscribe()
    }
  }, [])
}
