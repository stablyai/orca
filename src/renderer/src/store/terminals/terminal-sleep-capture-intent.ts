import type { OwnedPaneAgentRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  PaneSleepStopCondition,
  PaneSleepTarget
} from '../../../../shared/agent-session/lifecycle/pane-sleep-target'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../shared/structural-value-equality'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'

type Capture = {
  target: PaneSleepTarget
  record: OwnedPaneAgentRecord
  previous?: OwnedPaneAgentRecord
}
export type LocalPaneSleepCapture = {
  settle: () => Promise<void>
  canCommit: () => boolean
  conditionForPty: (ptyId: string) => PaneSleepStopCondition | undefined
}

/** Main conditionally admits the exact live source and persists it before one reversible stop. */
export async function stageLocalPaneSleep(
  get: TerminalStoreGet,
  set: TerminalStoreSet,
  worktreeId: string,
  records: Record<string, OwnedPaneAgentRecord>,
  before = get()
): Promise<LocalPaneSleepCapture> {
  const attempted: Capture[] = []
  const byTab = Map.groupBy(Object.values(records), (record) => parsePaneKey(record.paneKey)?.tabId)
  const sourceIsCurrent = (entry: Capture): boolean => {
    const pane = parsePaneKey(entry.target.paneKey)
    const state = get()
    return Boolean(
      pane &&
      state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === pane.tabId) &&
      state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] ===
        entry.target.ptyId &&
      state.agentStatusByPaneKey[entry.target.paneKey] ===
        before.agentStatusByPaneKey[entry.target.paneKey]
    )
  }
  const settle = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const [tabId, entries] of Map.groupBy(
      attempted,
      (entry) => parsePaneKey(entry.target.paneKey)!.tabId
    )) {
      try {
        const running: Capture[] = []
        for (const entry of entries) {
          if (!sourceIsCurrent(entry)) {
            continue
          }
          const observation = (
            await window.api.pty
              .inspectProcess(entry.target.ptyId, {
                foregroundOnly: true,
                expectedIncarnationId: entry.target.ptyIncarnationId
              })
              .catch(() => null)
          )?.foregroundObservation
          if (
            observation?.verdict === 'observed' &&
            observation.ptyId === entry.target.ptyId &&
            observation.ptyIncarnationId === entry.target.ptyIncarnationId &&
            observation.authorityGeneration === entry.target.authorityGeneration
          ) {
            running.push(entry)
          }
        }
        if (!running.length) {
          continue
        }
        // Conditional restoration also reconciles a lost admission reply: only our exact staged value may change.
        const reply = await callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
          command: {
            type: 'sleep',
            workspace: worktreeId,
            tabId,
            recordOnly: true,
            paneKeys: running.map((entry) => entry.target.paneKey),
            expectedTargets: running.map((entry) => entry.target),
            expectedRecords: running.map((entry) => entry.record),
            records: running.flatMap((entry) => entry.previous ?? [])
          }
        })
        if (!reply.ok) {
          continue
        }
        set((state) => {
          const next = { ...state.sleepingAgentSessionsByPaneKey }
          for (const entry of running) {
            const key = entry.target.paneKey
            if (
              !reply.result.slept?.includes(key) ||
              !sourceIsCurrent(entry) ||
              !equal(next[key], entry.record)
            ) {
              continue
            }
            if (entry.previous) {
              next[key] = entry.previous
            } else {
              delete next[key]
            }
          }
          return { sleepingAgentSessionsByPaneKey: next }
        })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'sleep_capture_settlement_unverified')
    }
  }
  try {
    for (const [tabId, entries] of byTab) {
      if (!tabId) {
        throw new Error('sleep_capture_pane_missing')
      }
      const captures: Capture[] = []
      for (const record of entries) {
        const pane = parsePaneKey(record.paneKey)!
        const ptyId = before.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId]
        if (!ptyId) {
          throw new Error('sleep_capture_binding_missing')
        }
        const observation = (await window.api.pty.inspectProcess(ptyId, { foregroundOnly: true }))
          ?.foregroundObservation
        if (observation?.verdict !== 'observed' || observation.ptyId !== ptyId) {
          throw new Error('sleep_capture_identity_unverifiable')
        }
        const entry: Capture = {
          record,
          previous: before.sleepingAgentSessionsByPaneKey[record.paneKey],
          target: {
            paneKey: record.paneKey,
            ptyId,
            ptyIncarnationId: observation.ptyIncarnationId,
            authorityGeneration: observation.authorityGeneration,
            sourceUpdatedAt: before.agentStatusByPaneKey[record.paneKey]?.updatedAt
          }
        }
        if (!sourceIsCurrent(entry)) {
          throw new Error('sleep_capture_source_changed')
        }
        captures.push(entry)
      }
      // Establish settlement before dispatch; a transport error does not prove the owner made no write.
      attempted.push(...captures)
      const reply = await callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
        command: {
          type: 'sleep',
          workspace: worktreeId,
          tabId,
          recordOnly: true,
          paneKeys: entries.map((record) => record.paneKey),
          records: entries,
          expectedTargets: captures.map((entry) => entry.target),
          expectedRecords: captures.flatMap((entry) => entry.previous ?? []),
          expectedAbsentPaneKeys: captures
            .filter((entry) => !entry.previous)
            .map((entry) => entry.target.paneKey)
        }
      })
      if (!reply?.ok) {
        throw new Error('sleep_capture_not_admitted')
      }
      set((state) => {
        const next = { ...state.sleepingAgentSessionsByPaneKey }
        for (const entry of captures) {
          if (
            reply.result.slept?.includes(entry.target.paneKey) &&
            sourceIsCurrent(entry) &&
            equal(next[entry.target.paneKey], entry.previous)
          ) {
            next[entry.target.paneKey] = entry.record
          }
        }
        return { sleepingAgentSessionsByPaneKey: next }
      })
      if (
        captures.some(
          (entry) =>
            !reply.result.slept?.includes(entry.target.paneKey) ||
            !sourceIsCurrent(entry) ||
            !equal(get().sleepingAgentSessionsByPaneKey[entry.target.paneKey], entry.record)
        )
      ) {
        throw new Error('sleep_capture_not_admitted')
      }
    }
  } catch (error) {
    await settle()
    throw error
  }
  return {
    settle,
    canCommit: () =>
      attempted.every((entry) => {
        const state = get()
        const pane = parsePaneKey(entry.target.paneKey)!
        const binding = state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
        const source = state.agentStatusByPaneKey[entry.target.paneKey]
        return (
          (!binding || binding === entry.target.ptyId) &&
          (!source || source === before.agentStatusByPaneKey[entry.target.paneKey]) &&
          equal(state.sleepingAgentSessionsByPaneKey[entry.target.paneKey], entry.record)
        )
      }),
    conditionForPty: (ptyId) => {
      const entry = attempted.find((candidate) => candidate.target.ptyId === ptyId)
      if (!entry) {
        return undefined
      }
      if (
        !sourceIsCurrent(entry) ||
        !equal(get().sleepingAgentSessionsByPaneKey[entry.target.paneKey], entry.record)
      ) {
        throw new Error('sleep_capture_source_changed')
      }
      return { workspace: worktreeId, target: entry.target, record: entry.record }
    }
  }
}
