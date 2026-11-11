import { useAppStore } from '@/store/index'
import { observeAgentPickerAcquisition } from '../../../../agent/agent-launch-picker-acquisition'
import { readAntigravityTerminalCatalog } from '@/runtime/terminal/terminal-model-discovery-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { AgentSessionModelOption } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { AgentPickerEntry } from '../../../../../../../shared/agent-launch/picker/agent-launch-picker'
import { resolveNativeChatModelDiscoveryContext } from '../catalog/native-chat-session-option-discovery'
import { antigravityTerminalCatalogModels } from '../../../../../../../shared/agent-session/options/antigravity-model-efforts'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-types'

export function createAntigravityTerminalModelDemand(terminalTabId: string) {
  let stop: (() => void) | undefined
  return {
    demand(publish: (models: CatalogModel[]) => void) {
      stop?.()
      let release: (() => void) | undefined
      let contextKey: string | undefined
      const refresh = () => {
        const current = resolveNativeChatModelDiscoveryContext(terminalTabId)
        const settings = useAppStore.getState().settings
        const key = JSON.stringify(
          current && [
            current.runtime.target,
            current.runtime.worktreeId,
            current.runtime.worktreePath,
            current.runtime.connectionId,
            current.hostKey,
            current.runtime.prefs?.agentCmdOverrides?.antigravity,
            settings?.agentDefaultEnv?.antigravity,
            settings?.terminalWindowsShell,
            settings?.terminalWindowsWslDistro
          ]
        )
        if (key === contextKey) {
          return
        }
        contextKey = key
        release?.()
        publish([])
        release = current
          ? observeAntigravityTerminalModels(current.runtime, key, (models) =>
              publish(antigravityTerminalCatalogModels(models))
            )
          : undefined
      }
      refresh()
      // Closed panes have no subscription; status-only events never scan workspace or tab rows.
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        if (
          state.tabsByWorktree !== previous.tabsByWorktree ||
          state.worktreesByRepo !== previous.worktreesByRepo ||
          state.folderWorkspaces !== previous.folderWorkspaces ||
          state.repos !== previous.repos ||
          state.projects !== previous.projects ||
          state.projectGroups !== previous.projectGroups ||
          state.restoredRuntimeHostIdByWorkspaceSessionKey !==
            previous.restoredRuntimeHostIdByWorkspaceSessionKey ||
          state.settings !== previous.settings
        ) {
          refresh()
        }
      })
      const close = () => {
        unsubscribe()
        release?.()
      }
      stop = close
      return () => {
        close()
        if (stop === close) {
          stop = undefined
        }
      }
    },
    dispose() {
      stop?.()
      stop = undefined
    }
  }
}

/** A terminal-only demand shares pending I/O and releases completed answers with its surface. */
export function observeAntigravityTerminalModels(
  runtime: RuntimeGitContext,
  hostKey: string,
  publish: (models: AgentSessionModelOption[]) => void
): () => void {
  const entry: AgentPickerEntry = {
    agent: 'antigravity',
    label: 'Antigravity',
    rows: [],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' }
  }
  const key = JSON.stringify([
    'antigravity-terminal-options',
    runtime.target,
    runtime.worktreeId,
    runtime.worktreePath,
    runtime.connectionId,
    hostKey,
    runtime.prefs?.agentCmdOverrides?.antigravity
  ])
  return observeAgentPickerAcquisition(
    key,
    [entry],
    {
      catalog: () => readAntigravityTerminalCatalog(runtime),
      support: async () => undefined
    },
    {
      selected: () => 'antigravity',
      publish: ([next]) => {
        if (next.terminalCatalogRead !== 'pending') {
          publish(
            next.terminalCatalogRead === 'settled' && next.terminalCatalog?.origin === 'probe'
              ? next.terminalCatalog.models
              : []
          )
        }
      }
    }
  )
}
