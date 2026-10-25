import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

import type { AppState } from '@/store/types'

import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'

import { discardStructuredLaunchPrompts } from './structured-agent-session-launch-prompt'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import {
  desktopCreateAcceptedTerminal,
  type DesktopCreateLaunchRecord
} from './structured-agent-session-launch-record'
import {
  deleteStructuredAgentLaunchRecords,
  desktopCreateIdentityKey,
  desktopCreateWorktreeKey,
  hasDesktopCreateLaunchRecords,
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  readStructuredAgentLaunchRecords,
  writeStructuredAgentLaunchRecords
} from './structured-agent-session-launch-persistence'
import {
  findStructuredLaunchTab,
  captureStructuredLaunchSurfaceAddress,
  openStructuredAgentSessionProvisionalTab
} from './structured-agent-session-provisional-surface'
import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'

onRuntimeEnvironmentsRetired((ids) => {
  if (!hasDesktopCreateLaunchRecords()) {
    return
  }
  const retired = new Set(ids.map((id) => `runtime:${id}`))
  const records = readStructuredAgentLaunchRecords().filter(
    (record) => record.desktopCreate && retired.has(record.executionHostId)
  )
  deleteStructuredAgentLaunchRecords(records.map((record) => record.sessionId))
  for (const record of records) {
    discardStructuredLaunchPrompts(record.sessionId)
  }
  if (records.length) {
    notifyStructuredLaunchListeners(false)
  }
})

/** Rows have already passed the catalog's host, environment and freshness admission. */
export function acceptDesktopCreateCatalog(
  hostId: ExecutionHostId,
  rows: readonly Worktree[],
  get: () => AppState
): void {
  if (!hasDesktopCreateLaunchRecords()) {
    return
  }
  const updates: DesktopCreateLaunchRecord[] = []
  const presentations: { record: DesktopCreateLaunchRecord; worktreeId: string }[] = []
  for (const row of rows) {
    const record =
      (row.instanceId
        ? readStructuredAgentLaunchRecord(desktopCreateIdentityKey(hostId, row.instanceId))
        : undefined) ?? readStructuredAgentLaunchRecord(desktopCreateWorktreeKey(hostId, row.id))
    const create = record?.desktopCreate
    if (
      !record ||
      !create ||
      record[desktopCreateAcceptedTerminal] ||
      (row.instanceId && row.instanceId !== create.params.createIdentity?.instanceId) ||
      create.params.target.kind !== 'create-worktree' ||
      record.executionHostId !== hostId ||
      create.params.target.create.repo.replace(/^id:/, '') !== row.repoId ||
      hasStructuredAgentLaunchCancellationTombstonePersisted(record.sessionId) ||
      (create.worktreeId && create.worktreeId !== row.id)
    ) {
      continue
    }
    const address =
      record.surfaceAddress ?? captureStructuredLaunchSurfaceAddress(row.id, undefined, get)
    if (!create.worktreeId || !record.surfaceAddress) {
      updates.push({
        ...record,
        desktopCreate: { ...create, worktreeId: row.id },
        surfaceAddress: address
      })
    }
    presentations.push({ record, worktreeId: row.id })
  }
  if (updates.length) {
    writeStructuredAgentLaunchRecords(updates)
  }
  for (const { record, worktreeId } of presentations) {
    if (!currentDesktopCreate(record)) {
      continue
    }
    try {
      openStructuredAgentSessionProvisionalTab(
        {
          worktreeId,
          executionHostId: hostId,
          sessionId: record.sessionId,
          agent: record.agent,
          activate: false
        },
        get
      )
    } catch (error) {
      console.warn('[structured-agent-launch] catalog presentation failed', error)
    }
  }
  if (updates.length) {
    notifyStructuredLaunchListeners(false)
  }
}

export function currentDesktopCreate(
  record: DesktopCreateLaunchRecord
): DesktopCreateLaunchRecord | undefined {
  const current = readStructuredAgentLaunchRecord(record.sessionId)
  return current?.desktopCreate &&
    current.desktopCreate.params === record.desktopCreate.params &&
    current.executionHostId === record.executionHostId &&
    !hasStructuredAgentLaunchCancellationTombstonePersisted(record.sessionId)
    ? current
    : undefined
}

export function presentDesktopCreateWorkspace(
  record: DesktopCreateLaunchRecord,
  worktreeId: string,
  get: () => AppState
): void {
  const current = currentDesktopCreate(record)
  if (
    !current ||
    !worktreeId ||
    current[desktopCreateAcceptedTerminal] ||
    (current.desktopCreate.worktreeId && current.desktopCreate.worktreeId !== worktreeId)
  ) {
    return
  }
  const next = {
    ...current,
    desktopCreate: { ...current.desktopCreate, worktreeId },
    surfaceAddress:
      current.surfaceAddress ?? captureStructuredLaunchSurfaceAddress(worktreeId, undefined, get)
  }
  writeStructuredAgentLaunchRecords([next])
  openStructuredAgentSessionProvisionalTab(
    {
      worktreeId,
      executionHostId: record.executionHostId,
      sessionId: record.sessionId,
      agent: record.agent,
      activate: false
    },
    get
  )
  notifyStructuredLaunchListeners(false)
}

export function removeDesktopCreateProvisional(
  record: DesktopCreateLaunchRecord,
  get: () => AppState
): void {
  const worktreeId = record.desktopCreate.worktreeId
  if (!worktreeId) {
    return
  }
  const tab = findStructuredLaunchTab(
    {
      worktreeId,
      sessionId: record.sessionId,
      executionHostId: record.executionHostId
    },
    get
  )
  if (tab) {
    try {
      get().closeUnifiedTab(tab.id, {
        agentSessionRetirementHandled: true,
        preserveWorktreeSelection: true,
        recordInteraction: false
      })
    } catch (error) {
      console.warn('[structured-agent-launch] provisional cleanup failed', error)
    }
  }
}

/** Accepted ordinary topology, never a reservation, retires only the exact ready terminal's chat placeholder. */
export function acceptDesktopCreateTopology(
  hostId: ExecutionHostId,
  snapshot: RuntimeMobileSessionTabsResult,
  get: () => AppState
): void {
  if (!hasDesktopCreateLaunchRecords()) {
    return
  }
  const settled: string[] = []
  const updates: DesktopCreateLaunchRecord[] = []
  const terminals: DesktopCreateLaunchRecord[] = []
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal' || tab.status !== 'ready' || !tab.terminal) {
      continue
    }
    const record = readStructuredAgentLaunchRecord(
      `desktop-pane:${hostId}:${tab.parentTabId}:${tab.leafId}`
    )
    if (
      !record?.desktopCreate ||
      record[desktopCreateAcceptedTerminal] ||
      record.agent !== tab.launchAgent ||
      (record.desktopCreate.worktreeId && record.desktopCreate.worktreeId !== snapshot.worktree) ||
      hasStructuredAgentLaunchCancellationTombstonePersisted(record.sessionId)
    ) {
      continue
    }
    const next: DesktopCreateLaunchRecord = {
      ...record,
      [desktopCreateAcceptedTerminal]: true,
      desktopCreate: { ...record.desktopCreate, worktreeId: snapshot.worktree }
    }
    terminals.push(next)
    if (record.lifecycle !== 'pending') {
      settled.push(record.sessionId)
    } else {
      updates.push(next)
    }
  }
  if (updates.length || settled.length) {
    writeStructuredAgentLaunchRecords(updates, settled)
    for (const record of terminals) {
      removeDesktopCreateProvisional(record, get)
    }
    notifyStructuredLaunchListeners(false)
  }
}
