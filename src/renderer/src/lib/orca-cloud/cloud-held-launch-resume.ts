// V3-01: after a restart, put back the holds the quit dropped. Each remembered placeholder tab comes
// back from the host as a plain shell; once it is in the store again, its hold is re-placed under the
// same key, so the strip and the sidebar's key mark return and Start launches the original agent and
// prompt. A record whose tab doesn't come back within a bounded wait is dropped (a workspace or
// sandbox deleted meanwhile ends that way, or ages out). A restored hold always waits for the
// person's explicit Start, even once its account covers the agent or is renewed.
import { useAppStore } from '@/store'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import {
  cloudTabHoldKey,
  holdCloudAgentLaunch,
  joinCloudAgentHold,
  readCloudAgentHold
} from './cloud-agent-launch-hold'
import {
  forgetHeldStructuredLaunch,
  readHeldStructuredLaunches,
  type HeldStructuredLaunchRecord
} from './cloud-structured-held-launch-memory'
import {
  markStructuredHoldResumed,
  structuredCloudHoldKey,
  takeStructuredHoldJoined
} from './cloud-structured-launch-hold'
import {
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from '@/lib/agent-session/launch/structured-agent-session-launch'
import { isOrcaCloudEnvironmentId } from './orca-cloud-environment-id'
import {
  forgetHeldCloudLaunch,
  readHeldCloudLaunches,
  type HeldCloudLaunchRecord
} from './cloud-held-launch-memory'
import {
  isTabOpen,
  settleHeldPlaceholder,
  type CreateHostTerminal
} from './cloud-web-host-launch-hold'

/** How long a restored placeholder may take to reach the store before its record is dropped. */
export const HELD_LAUNCH_RESTORE_WAIT_MS = 120_000

const resuming = new Set<string>()

function waitFor(ready: () => boolean, waitMs: number): Promise<boolean> {
  if (ready()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const finish = (found: boolean): void => {
      unsubscribe()
      clearTimeout(timer)
      resolve(found)
    }
    const unsubscribe = useAppStore.subscribe(() => {
      if (ready()) {
        finish(true)
      }
    })
    const timer = setTimeout(() => finish(false), waitMs)
  })
}

function waitForTab(record: HeldCloudLaunchRecord, waitMs: number): Promise<boolean> {
  return waitFor(() => isTabOpen(record.worktreeId, record.tabId), waitMs)
}

function structuredChatOpen(sessionId: string): boolean {
  return Object.values(useAppStore.getState().unifiedTabsByWorktree ?? {}).some((tabs) =>
    tabs?.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)
  )
}

const resumingChats = new Set<string>()

/**
 * V3-01b: put a held structured chat's hold back as soon as its tab is in the store, before (and
 * whatever becomes of) its launch's retry, so the strip and hint show at once. The retry joins this
 * hold; if none did by the time the person starts it, Start retries the launch (Cancel abandons it).
 */
async function resumeChat(record: HeldStructuredLaunchRecord, waitMs: number): Promise<void> {
  if (!(await waitFor(() => structuredChatOpen(record.sessionId), waitMs))) {
    console.info(
      `[orca-cloud] held chat dropped: ${record.sessionId} did not come back after restart`
    )
    forgetHeldStructuredLaunch(record.sessionId)
    return
  }
  const paneKey = structuredCloudHoldKey(record.sessionId)
  // The launch's own retry already holds (or is deciding to): it owns Start and Cancel.
  if (joinCloudAgentHold(paneKey)) {
    return
  }
  markStructuredHoldResumed(record.sessionId)
  const outcome = await holdCloudAgentLaunch({
    paneKey,
    agent: record.agent,
    prompt: null,
    restored: true
  })
  forgetHeldStructuredLaunch(record.sessionId)
  if (takeStructuredHoldJoined(record.sessionId)) {
    return
  }
  if (outcome === 'proceed') {
    retryStructuredAgentSessionLaunch(record.worktreeId, record.sessionId)
  } else {
    cancelStructuredAgentLaunch(record.worktreeId, record.sessionId)
  }
}

async function resumeOne(
  record: HeldCloudLaunchRecord,
  create: CreateHostTerminal,
  waitMs: number
): Promise<void> {
  if (!(await waitForTab(record, waitMs))) {
    console.info(
      `[orca-cloud] held launch dropped: tab ${record.tabId} did not come back after restart`
    )
    forgetHeldCloudLaunch(record.tabId)
    return
  }
  await settleHeldPlaceholder({
    args: {
      worktreeId: record.worktreeId,
      environmentId: record.environmentId,
      agent: record.agent,
      ...(record.prompt ? { prompt: record.prompt } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(record.targetGroupId ? { targetGroupId: record.targetGroupId } : {})
    },
    tabId: record.tabId,
    agent: record.agent,
    create,
    restored: true
  })
}

/**
 * Called when a host's session subscription opens (app start, reconnect). Idempotent: a placeholder
 * whose hold is already live (this run placed it) or already being resumed is left alone.
 */
export function resumeHeldCloudLaunches(
  environmentId: string,
  {
    create = createWebRuntimeSessionTerminalResult,
    waitMs = HELD_LAUNCH_RESTORE_WAIT_MS
  }: { create?: CreateHostTerminal; waitMs?: number } = {}
): void {
  if (!isOrcaCloudEnvironmentId(environmentId)) {
    return
  }
  // The records are per Orca profile: read them once the profile is known (it loads at app start).
  if (useAppStore.getState().activeOrcaProfileId == null) {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.activeOrcaProfileId != null) {
        unsubscribe()
        clearTimeout(timer)
        resumeHeldCloudLaunches(environmentId, { create, waitMs })
      }
    })
    const timer = setTimeout(unsubscribe, waitMs)
    return
  }
  for (const record of readHeldStructuredLaunches(environmentId)) {
    if (resumingChats.has(record.sessionId)) {
      continue
    }
    resumingChats.add(record.sessionId)
    void resumeChat(record, waitMs).finally(() => resumingChats.delete(record.sessionId))
  }
  for (const record of readHeldCloudLaunches(environmentId)) {
    if (resuming.has(record.tabId) || readCloudAgentHold(cloudTabHoldKey(record.tabId))) {
      continue
    }
    resuming.add(record.tabId)
    void resumeOne(record, create, waitMs).finally(() => resuming.delete(record.tabId))
  }
}

export function resetHeldCloudLaunchResumeForTest(): void {
  resuming.clear()
  resumingChats.clear()
}
