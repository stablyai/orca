import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceObservedWorktree,
  RemoteWorkspaceTabObservation
} from '../../../shared/remote-workspace-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import type { AppState } from '../store/types'

type ObservationApi = {
  forgetTabState: (args: { rendererGeneration: number; targetId: string }) => Promise<void>
  observeTabState: (observation: RemoteWorkspaceTabObservation) => Promise<void>
  startTabStateObservation: () => Promise<number>
}

type ScopeInputRefs = Pick<
  AppState,
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'remoteWorkspaceHydratedTargetIds'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export type DirectSshTabIntentObserver = {
  beginSnapshotApply: (targetId: string) => () => void
  clear: () => void
  observeState: (state: AppState) => void
}

type ObserverOptions = {
  onTargetScanned?: (targetId: string) => void
  rendererGeneration?: number
}

function configuredTargetIds(state: AppState): Set<string> {
  return new Set([
    ...state.sshTargetLabels.keys(),
    ...state.sshConnectionStates.keys(),
    ...state.remoteWorkspaceHydratedTargetIds
  ])
}

function scopeInputRefs(state: AppState): ScopeInputRefs {
  return {
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    remoteWorkspaceHydratedTargetIds: state.remoteWorkspaceHydratedTargetIds,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

function scopeInputsEqual(previous: ScopeInputRefs | null, next: ScopeInputRefs): boolean {
  return (
    previous !== null &&
    Object.keys(next).every(
      (key) => previous[key as keyof ScopeInputRefs] === next[key as keyof ScopeInputRefs]
    )
  )
}

function targetWorktreeIds(state: AppState, targetId: string): Set<string> {
  return resolveDirectSshTargetScope({
    targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

function worktreeRows(state: AppState): Map<string, Worktree[]> {
  const rows = new Map<string, Worktree[]>()
  const append = (worktree: Worktree): void => {
    rows.set(worktree.id, [...(rows.get(worktree.id) ?? []), worktree])
  }
  Object.values(state.worktreesByRepo).flat().forEach(append)
  Object.values(state.detectedWorktreesByRepo)
    .flatMap((result) => result.worktrees)
    .forEach(append)
  return rows
}

function processIdentity(state: AppState, tab: TerminalTab): string {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const leafPtys = Object.entries(layout?.ptyIdsByLeafId ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  return JSON.stringify([
    tab.ptyId,
    tab.generation ?? null,
    state.lastKnownRelayPtyIdByTabId?.[tab.id] ?? null,
    state.ptyIdsByTabId?.[tab.id] ?? [],
    leafPtys
  ])
}

function observedTab(
  state: AppState,
  tab: TerminalTab,
  worktreePath: string
): RemoteWorkspaceObservedTab {
  const {
    worktreeId: _worktreeId,
    pendingActivationSpawn: _pendingActivationSpawn,
    ...remoteTab
  } = tab
  void _worktreeId
  void _pendingActivationSpawn
  const layout = state.terminalLayoutsByTabId[tab.id]
  return {
    tab: { ...remoteTab, worktreePath },
    ...(layout ? { layout } : {}),
    processIdentity: processIdentity(state, tab)
  }
}

function observedWorktrees(
  state: AppState,
  worktreeIds: ReadonlySet<string>
): RemoteWorkspaceObservedWorktree[] {
  const rows = worktreeRows(state)
  const observed: RemoteWorkspaceObservedWorktree[] = []
  for (const worktreeId of worktreeIds) {
    const parsed = splitWorktreeId(worktreeId)
    const candidates = rows.get(worktreeId) ?? []
    const instanceIds = new Set(
      candidates.map((worktree) => worktree.instanceId?.trim()).filter(Boolean)
    )
    if (!parsed || candidates.length === 0 || instanceIds.size > 1) {
      continue
    }
    observed.push({
      worktreeId,
      worktreeInstanceId: instanceIds.size === 1 ? ([...instanceIds][0] ?? null) : null,
      worktreePath: parsed.worktreePath,
      tabs: (state.tabsByWorktree[worktreeId] ?? []).map((tab) =>
        observedTab(state, tab, parsed.worktreePath)
      )
    })
  }
  return observed
}

function observationSignature(worktrees: readonly RemoteWorkspaceObservedWorktree[]): string {
  return JSON.stringify(
    worktrees.map((worktree) => [
      worktree.worktreeId,
      worktree.worktreeInstanceId,
      worktree.tabs.map((tab) => [tab.tab.id, tab.tab.createdAt, tab.processIdentity])
    ])
  )
}

export function createDirectSshTabIntentObserver(
  api: ObservationApi,
  options: ObserverOptions = {}
): DirectSshTabIntentObserver {
  let rendererGeneration = options.rendererGeneration ?? null
  let stopped = false
  const generationReady =
    rendererGeneration === null
      ? api.startTabStateObservation().then((generation) => {
          rendererGeneration = generation
          return generation
        })
      : Promise.resolve(rendererGeneration)
  const pausedTargets = new Set<string>()
  let scopeByTarget = new Map<string, Set<string>>()
  let targetByWorktree = new Map<string, string>()
  let previousScopeInputs: ScopeInputRefs | null = null
  let previousTabsByWorktree: AppState['tabsByWorktree'] | null = null
  let signatureByTarget = new Map<string, string>()
  let latestState: AppState | null = null

  const withGeneration = (run: (generation: number) => Promise<void>): void => {
    if (stopped) {
      return
    }
    if (rendererGeneration !== null) {
      void run(rendererGeneration).catch(() => {})
      return
    }
    void generationReady
      .then((generation) => (stopped ? undefined : run(generation)))
      .catch(() => {})
  }

  const sendTarget = (state: AppState, targetId: string, authoritative = false): void => {
    if (pausedTargets.has(targetId)) {
      return
    }
    options.onTargetScanned?.(targetId)
    const worktrees = observedWorktrees(state, scopeByTarget.get(targetId) ?? new Set())
    const hydrated = state.remoteWorkspaceHydratedTargetIds.has(targetId)
    const signature = JSON.stringify([hydrated, observationSignature(worktrees)])
    if (!authoritative && signatureByTarget.get(targetId) === signature) {
      return
    }
    signatureByTarget.set(targetId, signature)
    withGeneration((generation) =>
      api.observeTabState({
        ...(authoritative ? { authoritative: true } : {}),
        connected: state.sshConnectionStates.get(targetId)?.status === 'connected',
        hydrated,
        rendererGeneration: generation,
        targetId,
        worktrees
      })
    )
  }

  const observeState = (state: AppState): void => {
    latestState = state
    const nextScopeInputs = scopeInputRefs(state)
    const scopeChanged = !scopeInputsEqual(previousScopeInputs, nextScopeInputs)
    if (!scopeChanged && previousTabsByWorktree === state.tabsByWorktree) {
      return
    }
    const previousTabs = previousTabsByWorktree
    previousScopeInputs = nextScopeInputs
    previousTabsByWorktree = state.tabsByWorktree
    const targetsToSend = new Set<string>()
    if (scopeChanged) {
      const targetIds = configuredTargetIds(state)
      for (const targetId of scopeByTarget.keys()) {
        if (!targetIds.has(targetId)) {
          scopeByTarget.delete(targetId)
          signatureByTarget.delete(targetId)
          withGeneration((generation) =>
            api.forgetTabState({ rendererGeneration: generation, targetId })
          )
        }
      }
      const ownersByWorktree = new Map<string, string[]>()
      const rawScopeByTarget = new Map<string, Set<string>>()
      for (const targetId of targetIds) {
        const worktreeIds = targetWorktreeIds(state, targetId)
        rawScopeByTarget.set(targetId, worktreeIds)
        for (const worktreeId of worktreeIds) {
          ownersByWorktree.set(worktreeId, [...(ownersByWorktree.get(worktreeId) ?? []), targetId])
        }
      }
      scopeByTarget = new Map(
        [...rawScopeByTarget].map(([targetId, worktreeIds]) => [
          targetId,
          new Set(
            [...worktreeIds].filter((worktreeId) => ownersByWorktree.get(worktreeId)?.length === 1)
          )
        ])
      )
      targetByWorktree = new Map(
        [...scopeByTarget].flatMap(([targetId, worktreeIds]) =>
          [...worktreeIds].map((worktreeId) => [worktreeId, targetId] as const)
        )
      )
      targetIds.forEach((targetId) => targetsToSend.add(targetId))
    } else if (previousTabs) {
      for (const worktreeId of new Set([
        ...Object.keys(previousTabs),
        ...Object.keys(state.tabsByWorktree)
      ])) {
        if (previousTabs[worktreeId] !== state.tabsByWorktree[worktreeId]) {
          const targetId = targetByWorktree.get(worktreeId)
          if (targetId) {
            targetsToSend.add(targetId)
          }
        }
      }
    }
    targetsToSend.forEach((targetId) => sendTarget(state, targetId))
  }

  return {
    observeState,
    beginSnapshotApply: (targetId) => {
      pausedTargets.add(targetId)
      let ended = false
      return () => {
        if (ended) {
          return
        }
        ended = true
        pausedTargets.delete(targetId)
        if (latestState) {
          sendTarget(latestState, targetId, true)
        }
      }
    },
    clear: () => {
      stopped = true
      pausedTargets.clear()
      scopeByTarget.clear()
      targetByWorktree.clear()
      signatureByTarget.clear()
      previousScopeInputs = null
      previousTabsByWorktree = null
      latestState = null
    }
  }
}
