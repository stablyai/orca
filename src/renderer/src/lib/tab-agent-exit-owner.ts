import type { AgentStatusOwner } from '@/store/agent-status-commit'
import {
  reportAgentStatusObserverError,
  type AgentStatusReadState
} from '@/store/agent-status-observers'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import {
  getTerminalTabOwnerWorktreeId,
  getTerminalTabOwners
} from '@/store/slices/terminal-tab-owner-index'
import { getCachedTerminalTabForWorktree } from '@/components/terminal-pane/terminal-tab-lookup'
import {
  terminalAgentEvidenceScopes,
  terminalAgentEvidenceScopeKey
} from './terminal-agent-evidence-scopes'
import { tabAgentExitSignals } from './tab-agent-exit-signals'
import { resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'
import { affectedExitEvidenceTabs } from './tab-agent-exit-inputs'

type Observation = { generation: string; scopes: ReadonlyMap<string, boolean> }
const services = new WeakMap<AgentStatusOwner, ReturnType<typeof createTabAgentExitOwner>>()

export function getTabAgentExitOwner(status: AgentStatusOwner) {
  let service = services.get(status)
  if (!service) {
    service = createTabAgentExitOwner(status)
    services.set(status, service)
  }
  return service
}

function rawTab(state: AgentStatusReadState, tabId: string): TerminalTab | null {
  const workspace = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  return workspace ? getCachedTerminalTabForWorktree(state.tabsByWorktree, workspace, tabId) : null
}

function createTabAgentExitOwner(status: AgentStatusOwner) {
  const observations = new Map<string, Observation>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (tabId: string): void => {
    for (const listener of listeners.get(tabId) ?? []) {
      try {
        listener()
      } catch (error) {
        reportAgentStatusObserverError(error)
      }
    }
  }
  const forget = (tabId: string): void => {
    if (observations.delete(tabId)) {
      notify(tabId)
    }
  }
  const observe = (tab: TerminalTab, accepted: AgentStatusReadState): void => {
    const current = status.getState()
    const currentTab = rawTab(current, tab.id)
    if (!currentTab) {
      forget(tab.id)
      return
    }
    const signals = tabAgentExitSignals(accepted, tab)
    const currentSignals = tabAgentExitSignals(current, currentTab)
    // Accepted evidence belongs only to the terminal/process generation that produced it.
    if (currentTab !== tab || currentSignals.generation !== signals.generation) {
      return
    }
    const currentScopes = new Map(
      terminalAgentEvidenceScopes(current, currentTab).map((scope) => [scope.key, scope.title])
    )
    const previous = observations.get(tab.id)
    const scopes = new Map<string, boolean>()
    const exits = new Set<string>()
    for (const scope of terminalAgentEvidenceScopes(accepted, tab)) {
      if (!currentScopes.has(scope.key)) {
        continue
      }
      const explicitTitle = resolveExplicitTerminalTitleAgentType(scope.title)
      const fallback = tab.launchAgent
        ? explicitTitle === tab.launchAgent
        : Boolean(explicitTitle || signals.siblingHookAgent)
      const observed = Boolean(
        (previous?.generation === signals.generation && previous.scopes.get(scope.key)) ||
        signals.hookAgent ||
        signals.hasCompletedHook ||
        signals.processAgent ||
        fallback
      )
      scopes.set(scope.key, observed)
      const acceptedExit = resolveLaunchedAgentExitEvidence({
        ...signals,
        title: scope.title,
        defaultTitle: tab.defaultTitle,
        hasObservedAgentSignal: observed
      })
      if (tab.launchAgent && acceptedExit) {
        exits.add(scope.key)
      }
    }
    // Publish every independent scope before an action can recursively publish another pair.
    observations.set(tab.id, { generation: signals.generation, scopes })
    if (
      previous?.generation !== signals.generation ||
      previous.scopes.size !== scopes.size ||
      [...scopes].some(([key, observed]) => previous.scopes.get(key) !== observed)
    ) {
      notify(tab.id)
    }
    if (exits.size === 0) {
      return
    }
    const latest = status.getState()
    if (rawTab(latest, tab.id) !== tab) {
      return
    }
    const blockers = tabAgentExitSignals(latest, tab)
    if (blockers.generation !== signals.generation) {
      return
    }
    if (
      terminalAgentEvidenceScopes(latest, tab).some(
        (scope) =>
          exits.has(scope.key) &&
          resolveLaunchedAgentExitEvidence({
            ...blockers,
            title: scope.title,
            defaultTitle: tab.defaultTitle,
            hasObservedAgentSignal: scopes.get(scope.key) ?? false
          })
      )
    ) {
      latest.clearTabLaunchAgent(tab.id)
    }
  }
  return {
    getObservation(worktreeId: string, tabId: string, groupId?: string): boolean {
      return (
        observations
          .get(tabId)
          ?.scopes.get(terminalAgentEvidenceScopeKey(worktreeId, tabId, groupId)) ?? false
      )
    },
    subscribe(tabId: string, listener: () => void): () => void {
      let bucket = listeners.get(tabId)
      if (!bucket) {
        bucket = new Set()
        listeners.set(tabId, bucket)
      }
      bucket.add(listener)
      return () => {
        bucket.delete(listener)
        if (bucket.size === 0) {
          listeners.delete(tabId)
        }
      }
    },
    start(): () => void {
      const unsubscribe = status.subscribeTransitions((transition) => {
        for (const id of affectedExitEvidenceTabs(transition)) {
          const tab = rawTab(transition.next, id)
          if (tab) {
            observe(tab, transition.next)
          } else if (!rawTab(status.getState(), id)) {
            forget(id)
          }
        }
      })
      const initial = status.getState()
      for (const id of getTerminalTabOwners(initial.tabsByWorktree).keys()) {
        const tab = rawTab(initial, id)
        if (tab) {
          observe(tab, initial)
        }
      }
      return () => {
        unsubscribe()
        for (const id of observations.keys()) {
          forget(id)
        }
      }
    }
  }
}
