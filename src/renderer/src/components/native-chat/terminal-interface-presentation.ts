import { useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import {
  terminalInterfaceObservationsEqual,
  terminalInterfaceSnapshotSchema
} from '../../../../shared/terminal-interface-observation'
import {
  subscribePaneStartupState,
  isPaneResumingInPlace,
  isPaneSpawnDeferred
} from '@/lib/pane-spawn-deferral-registry'

export type TerminalInterfacePresentationState = Partial<
  Pick<
    AppState,
    | 'terminalInterfaceByPtyId'
    | 'terminalLayoutsByTabId'
    | 'pendingStartupByTabId'
    | 'automaticAgentResumeClaimsByTabId'
    | 'suppressedPtyExitIds'
    | 'agentLaunchConfigByPaneKey'
    | 'paneForegroundAgentByPaneKey'
  >
>

const presentationListeners = new Set<() => void>()
let presentationRevision = 0
export function terminalInterfacePresentationRevision(): number {
  return presentationRevision
}

export function subscribeTerminalInterfacePresentation(listener: () => void): () => void {
  const releaseStore = useAppStore.subscribe(listener)
  presentationListeners.add(listener)
  return () => {
    releaseStore()
    presentationListeners.delete(listener)
  }
}

export function useTerminalInterfacePresentation<T>(selector: (state: AppState) => T): T {
  const select = useShallow(selector)
  return useSyncExternalStore(subscribeTerminalInterfacePresentation, () =>
    select(useAppStore.getState())
  )
}

let refreshQueued = false
/** Imperative startup owners notify derived policy; this queue stores no eligibility truth. */
export function refreshTerminalInterfacePresentation(): void {
  if (
    refreshQueued ||
    Object.keys(useAppStore.getState().terminalInterfaceByPtyId ?? {}).length === 0
  ) {
    return
  }
  refreshQueued = true
  queueMicrotask(() => {
    refreshQueued = false
    presentationRevision += 1
    for (const listener of presentationListeners) {
      listener()
    }
  })
}
subscribePaneStartupState(refreshTerminalInterfacePresentation)

const versions = new Map<string, { epoch: string; revision: number }>()
const mounted = new Map<
  string,
  {
    ptyId: () => string | null
    incarnation: () => string | null
    pending: () => boolean
    cold: () => boolean
  }
>()

export function registerTerminalInterfacePresentation(
  paneKey: string,
  reader: {
    ptyId: () => string | null
    incarnation: () => string | null
    pending: () => boolean
    cold: () => boolean
  }
): () => void {
  mounted.set(paneKey, reader)
  refreshTerminalInterfacePresentation()
  return () => {
    if (mounted.get(paneKey) === reader) {
      mounted.delete(paneKey)
      refreshTerminalInterfacePresentation()
    }
  }
}

export function applyTerminalInterfaceSnapshot(value: unknown, environmentId: string | null): void {
  const parsed = terminalInterfaceSnapshotSchema.safeParse(value)
  if (!parsed.success) {
    return
  }
  const snapshot = parsed.data
  const key = environmentId ?? 'local'
  const previous = versions.get(key)
  if (previous?.epoch === snapshot.epoch && previous.revision > snapshot.revision) {
    return
  }
  versions.set(key, { epoch: snapshot.epoch, revision: snapshot.revision })
  useAppStore.setState((state) => {
    const next = { ...state.terminalInterfaceByPtyId }
    for (const [paneKey, entry] of Object.entries(next)) {
      if (entry.environmentId === environmentId) {
        delete next[paneKey]
      }
    }
    for (const observation of snapshot.observations) {
      if (observation.epoch !== snapshot.epoch) {
        continue
      }
      const hostPane = parsePaneKey(observation.paneKey)
      if (!hostPane) {
        continue
      }
      const paneKey = environmentId
        ? `${toWebTerminalSurfaceTabId(hostPane.tabId)}:${hostPane.leafId}`
        : observation.paneKey
      const ptyId = environmentId
        ? toRemoteRuntimePtyId(observation.terminalHandle, environmentId)
        : observation.ptyId
      next[ptyId] = {
        observation: {
          ...observation,
          paneKey,
          ptyId: environmentId
            ? toRemoteRuntimePtyId(observation.terminalHandle, environmentId)
            : observation.ptyId
        },
        environmentId
      }
    }
    const priorKeys = Object.keys(state.terminalInterfaceByPtyId)
    if (
      priorKeys.length === Object.keys(next).length &&
      priorKeys.every(
        (id) =>
          next[id]?.environmentId === state.terminalInterfaceByPtyId[id].environmentId &&
          terminalInterfaceObservationsEqual(
            next[id]?.observation,
            state.terminalInterfaceByPtyId[id].observation
          )
      )
    ) {
      return state
    }
    return { terminalInterfaceByPtyId: next }
  })
}

export function readTerminalInterface(state: TerminalInterfacePresentationState, paneKey: string) {
  const split = paneKey.lastIndexOf(':')
  const tabId = paneKey.slice(0, split)
  const leafId = paneKey.slice(split + 1)
  const reader = mounted.get(paneKey)
  const ptyId = reader?.ptyId() ?? state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[leafId]
  const entry = ptyId ? state.terminalInterfaceByPtyId?.[ptyId] : null
  if (
    !entry ||
    entry.observation.paneKey !== paneKey ||
    (reader && reader.incarnation() !== entry.observation.incarnationId)
  ) {
    return null
  }
  return entry
}

export function terminalInterfaceReleasesChat(
  state: TerminalInterfacePresentationState,
  paneKey: string
): boolean {
  const entry = readTerminalInterface(state, paneKey)
  if (!entry || entry.observation.state !== 'shell') {
    return false
  }
  const reader = mounted.get(paneKey)
  const tabId = paneKey.slice(0, paneKey.lastIndexOf(':'))
  if (
    reader?.pending() ||
    isPaneSpawnDeferred(paneKey) ||
    isPaneResumingInPlace(paneKey) ||
    state.pendingStartupByTabId?.[tabId] ||
    state.automaticAgentResumeClaimsByTabId?.[tabId] ||
    state.suppressedPtyExitIds?.[entry.observation.ptyId]
  ) {
    return false
  }
  const launch = state.agentLaunchConfigByPaneKey?.[paneKey]
  if (
    launch &&
    (!launch.identity.launchToken ||
      launch.identity.launchToken !== entry.observation.executionLaunchToken)
  ) {
    return false
  }
  // A cold row has no execution receipt; absent imperative startup state stays ambiguous.
  return entry.observation.basis !== 'cold' || reader?.cold() === true
}

export function nativeChatShellForeground(
  state: TerminalInterfacePresentationState,
  paneKey: string
): boolean {
  return readTerminalInterface(state, paneKey)
    ? terminalInterfaceReleasesChat(state, paneKey)
    : state.paneForegroundAgentByPaneKey?.[paneKey]?.shellForeground === true
}
