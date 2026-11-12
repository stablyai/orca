import { useAppStore } from '@/store/index'
import { observeAgentPickerAcquisition } from '../../../../agent/agent-launch-picker-acquisition'
import {
  readAntigravityTerminalCatalog,
  terminalModelDiscoveryDescriptor,
  terminalModelDiscoveryOwnerInputs,
  terminalModelDiscoveryRuntimeIdentity,
  type TerminalModelDiscoveryDescriptor
} from '@/runtime/terminal/terminal-model-discovery-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { AgentSessionModelOption } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { AgentPickerEntry } from '../../../../../../../shared/agent-launch/picker/agent-launch-picker'
import { resolveWorktreeModelDiscoveryRuntime } from '../catalog/native-chat-session-option-discovery'
import { antigravityTerminalCatalogModels } from '../../../../../../../shared/agent-session/options/antigravity-model-efforts'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../../../shared/agent-launch/catalog/tui-agent-display-names'

export function createAntigravityTerminalModelDemand(terminalTabId: string) {
  let stop: (() => void) | undefined
  return {
    demand(publish: (models: CatalogModel[]) => void) {
      stop?.()
      let release: (() => void) | undefined
      let contextKey: string | undefined
      let current: TerminalModelDiscoveryDescriptor | null = null
      let identity: string | undefined
      const refresh = () => {
        const state = useAppStore.getState()
        const owner = Object.entries(state.tabsByWorktree ?? {})
          .map(([worktreeId, tabs]) => ({
            worktreeId,
            tab: tabs.find((tab) => tab.id === terminalTabId)
          }))
          .find(({ tab }) => tab)
        const runtime = owner ? resolveWorktreeModelDiscoveryRuntime(state, owner.worktreeId) : null
        current = runtime
          ? terminalModelDiscoveryDescriptor(
              state,
              runtime,
              owner?.tab?.startupCwd ? { cwd: owner.tab.startupCwd } : {}
            )
          : null
        identity = terminalModelDiscoveryRuntimeIdentity(state, current?.runtime)
        const key = current?.key
        if (key === contextKey) {
          return
        }
        contextKey = key
        release?.()
        publish([])
        release = current
          ? observeAntigravityTerminalModels(
              current.runtime,
              current.key,
              (models) => publish(antigravityTerminalCatalogModels(models)),
              current
            )
          : undefined
      }
      refresh()
      // Closed panes have no subscription; status-only events never scan workspace or tab rows.
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        const before = terminalModelDiscoveryOwnerInputs(previous)
        if (
          state.tabsByWorktree !== previous.tabsByWorktree ||
          terminalModelDiscoveryOwnerInputs(state).some(
            (value, index) => value !== before[index]
          ) ||
          terminalModelDiscoveryRuntimeIdentity(state, current?.runtime) !== identity
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
  publish: (models: AgentSessionModelOption[]) => void,
  descriptor = terminalModelDiscoveryDescriptor(useAppStore.getState(), runtime)
): () => void {
  const entry: AgentPickerEntry = {
    agent: 'antigravity',
    label: TUI_AGENT_DISPLAY_NAMES.antigravity,
    rows: [],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' }
  }
  const key = JSON.stringify(['antigravity-terminal-options', hostKey, descriptor.key])
  return observeAgentPickerAcquisition(
    key,
    [entry],
    {
      catalog: () => readAntigravityTerminalCatalog(descriptor.runtime, descriptor.launch),
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
