import { useAppStore } from '@/store'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { stablePaneHasLivePty } from '@/lib/sleeping-agent-pane-ownership'
import {
  clearPaneSpawnDeferral,
  getPaneSpawnDeferral,
  setPaneSpawnDeferral
} from '@/lib/pane-spawn-deferral-registry'
import {
  cancelDeferredRestoreRetry,
  queueDeferredRestoreRetry
} from '@/lib/pane-spawn-deferral-drain'
import {
  canResumeHostAutomaticRestores,
  resumeHostAutomaticRestores
} from '@/runtime/resume-host-automatic-restores'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { releaseHiddenAgentResumeHold } from './hidden-agent-resume-deferral'
import { startPaneThroughMainThenAttach } from './main-pane-start-request'
import type {
  ColdRestoreAgentResumeStartup,
  FreshSpawnOptions,
  PendingStartupCommand
} from './fresh-spawn-types'

const SESSION_RUNNING_ELSEWHERE_NOTICE =
  '\r\n\x1b[2mThis agent session is already running in another tab.\x1b[0m\r\n'

type DeferredSpawn = {
  reason: SpawnDeferralReason
  startupOverride: PendingStartupCommand | null | undefined
  options: FreshSpawnOptions
}

function isColdRestoreStartup(
  startup: PendingStartupCommand | null | undefined
): startup is ColdRestoreAgentResumeStartup {
  return Boolean(startup && 'launchConfig' in startup && 'resumeProviderSession' in startup)
}

/** The record a deferred restore leaves behind, so the session stays listed and resumable even if
 *  this pane goes away before the user opens it. */
function deferredResumeRecord(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): SleepingAgentSessionRecord | null {
  const coldRestore = isColdRestoreStartup(startupOverride) ? startupOverride : null
  const agent = coldRestore?.agent ?? session.paneStartup?.launchAgent
  const providerSession =
    coldRestore?.resumeProviderSession ?? session.paneStartup?.resumeProviderSession
  if (!agent || !isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  const launchConfig = coldRestore?.launchConfig ?? session.paneStartup?.launchConfig
  const now = Date.now()
  return {
    paneKey: session.cacheKey,
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    agent,
    providerSession,
    prompt: '',
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    ...(launchConfig ? { launchConfig } : {}),
    // Quit origin preserves unfinished existing-pane records during sweeps; completed live bookmarks are passive history.
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
}

function providerSessionLiveInAnotherPane(resume: SleepingAgentSessionRecord): boolean {
  const state = useAppStore.getState()
  return Object.values(state.agentStatusByPaneKey).some((entry) => {
    const pane = entry.paneKey === resume.paneKey ? null : parsePaneKey(entry.paneKey)
    return (
      pane !== null &&
      entry.agentType === resume.agent &&
      agentProviderSessionsEqual(resume.agent, entry.providerSession, resume.providerSession) &&
      stablePaneHasLivePty(
        pane.tabId,
        pane.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[pane.tabId]
      )
    )
  })
}

function providerSessionQueuedInAnotherTab(
  resume: SleepingAgentSessionRecord,
  ownTabId: string
): boolean {
  const state = useAppStore.getState()
  const sameSession = (
    agent: string | undefined,
    providerSession: AgentProviderSessionMetadata | undefined
  ): boolean =>
    agent === resume.agent &&
    agentProviderSessionsEqual(resume.agent, providerSession, resume.providerSession)
  return (
    Object.entries(state.pendingStartupByTabId).some(
      ([tabId, startup]) =>
        tabId !== ownTabId && sameSession(startup.launchAgent, startup.resumeProviderSession)
    ) ||
    Object.entries(state.automaticAgentResumeClaimsByTabId).some(
      ([tabId, claim]) =>
        tabId !== ownTabId && sameSession(claim.launchAgent, claim.providerSession)
    )
  )
}

/** Adds "Resume automatic restores" once the pane's host proves it can clear the pause. */
function offerHostResume(
  session: ConnectPanePtySession,
  deferral: { reason: SpawnDeferralReason; resume: () => void }
): void {
  const environmentId: string | null = session.runtimeEnvironmentId ?? null
  void canResumeHostAutomaticRestores(environmentId).then((supported) => {
    if (!supported || getPaneSpawnDeferral(session.cacheKey)?.resume !== deferral.resume) {
      return
    }
    setPaneSpawnDeferral(session.cacheKey, {
      ...deferral,
      resumeAutomaticRestores: () => {
        void resumeHostAutomaticRestores(environmentId)
          .catch((error: unknown) => {
            console.warn('[terminal] could not resume automatic restores', error)
          })
          // Why either way: the user asked for this pane, which resumes as their own even if paused.
          .finally(() => deferral.resume())
      }
    })
  })
}

/** A restore the host kept asleep: the pane shows a sleeping overlay and retries when opened. */
export function installSpawnDeferredSleep(session: ConnectPanePtySession): void {
  // Set by the transport for the spawn in flight; read when that spawn settles without a PTY.
  session.pendingSpawnDeferral = null
  session.deferredSpawn = null

  session.enterSpawnDeferredSleep = (
    reason: SpawnDeferralReason,
    startupOverride: PendingStartupCommand | null | undefined,
    options: FreshSpawnOptions,
    visibleAtSpawn: boolean
  ): void => {
    const record = deferredResumeRecord(session, startupOverride)
    if (record) {
      // Why left after a later resume: the next quit capture replaces it, and a pane with a live PTY owns it.
      useAppStore.getState().rememberSleepingAgentSession(record)
    }
    session.deferredSpawn = { reason, startupOverride, options }
    const deferral = { reason, resume: () => void session.resumeDeferredSpawn() }
    setPaneSpawnDeferral(session.cacheKey, deferral)
    if (reason === 'paused') {
      // Why no background retry: a crash pause is cleared by the user, not by waiting.
      offerHostResume(session, deferral)
    } else {
      queueDeferredRestoreRetry(
        session.cacheKey,
        session.runtimeEnvironmentId ?? null,
        async () => (await session.resumeDeferredSpawn().catch(() => null)) !== null
      )
    }
    if (!visibleAtSpawn) {
      // Why: a pane opened while its hidden restore was in flight resumes as the user's own.
      queueMicrotask(() => session.resumeDeferredSpawnOnReveal())
    }
  }

  session.resumeDeferredSpawn = (): Promise<string | null> => {
    const deferred: DeferredSpawn | null = session.deferredSpawn
    if (!deferred || session.disposed || session.transport.getPtyId()) {
      return Promise.resolve(null)
    }
    session.deferredSpawn = null
    cancelDeferredRestoreRetry(session.cacheKey)
    const resume = deferredResumeRecord(session, deferred.startupOverride)
    if (
      resume &&
      (providerSessionLiveInAnotherPane(resume) ||
        providerSessionQueuedInAnotherTab(resume, session.deps.tabId))
    ) {
      clearPaneSpawnDeferral(session.cacheKey)
      // Why no spawn: the session runs or is starting elsewhere, and a second `--resume` forks it.
      writeTerminalOutput(session.pane.terminal, SESSION_RUNNING_ELSEWHERE_NOTICE, {
        foreground: session.deps.isVisibleRef.current === true
      })
      return Promise.resolve(null)
    }
    // Retain session ownership until PTY binding so activation cannot resume it in another tab mid-spawn.
    const resuming = { reason: deferred.reason, resume: () => {}, resuming: true as const }
    setPaneSpawnDeferral(session.cacheKey, resuming)
    const settle = (): void => {
      if (getPaneSpawnDeferral(session.cacheKey) === resuming) {
        clearPaneSpawnDeferral(session.cacheKey)
      }
    }
    return startPaneThroughMainThenAttach(session, () =>
      session.startFreshSpawn(deferred.startupOverride, deferred.options)
    ).then(
      (ptyId: string | null) => {
        settle()
        return ptyId
      },
      (error: unknown) => {
        settle()
        throw error
      }
    )
  }

  session.resumeDeferredSpawnOnReveal = (): void => {
    if (session.deferredSpawn && session.deps.isVisibleRef.current) {
      void session.resumeDeferredSpawn()
    }
  }

  session.disposeSpawnDeferral = (): void => {
    session.deferredSpawn = null
    cancelDeferredRestoreRetry(session.cacheKey)
    clearPaneSpawnDeferral(session.cacheKey)
    releaseHiddenAgentResumeHold(session)
  }
}
