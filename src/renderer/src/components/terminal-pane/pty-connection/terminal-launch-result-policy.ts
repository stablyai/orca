import {
  agentProviderSessionsEqual,
  type TerminalLaunchResult
} from '../../../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ReattachPayloadSession } from './reattach-payload-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyPaneStartup } from '../pty-connection-types'

type SavedStartup = ColdRestoreAgentResumeStartup | PtyPaneStartup

export function captureTerminalLaunchContext(
  session: ConnectPanePtySession | ReattachPayloadSession,
  startup: SavedStartup
) {
  const state = useAppStore.getState()
  return {
    startup,
    registration: state.agentLaunchConfigByPaneKey[session.cacheKey],
    status: state.agentStatusByPaneKey[session.cacheKey],
    paneStartup: session.paneStartup
  }
}

export type TerminalLaunchContext = ReturnType<typeof captureTerminalLaunchContext>

export function applyTerminalLaunchResult(
  session: ConnectPanePtySession | ReattachPayloadSession,
  result: TerminalLaunchResult & { isReattach?: boolean },
  context: TerminalLaunchContext,
  kind: 'creator' | 'observer' | 'candidate'
): boolean {
  const startup = context.startup
  const decision = result.savedResumeDecision
  const agent = startup && ('agent' in startup ? startup.agent : startup.launchAgent)
  const matches = Boolean(
    startup &&
    decision &&
    decision.agent === agent &&
    agentProviderSessionsEqual(
      decision.agent,
      decision.providerSession,
      startup.resumeProviderSession
    )
  )
  const candidateRejected = kind === 'candidate' && (!matches || decision?.verdict !== 'admitted')
  const rejected = Boolean(
    result.agentResumeRefused || result.agentResumeUnavailable || candidateRejected
  )
  const state = useAppStore.getState()
  const currentStartup = session.paneStartup
  const currentRegistration = state.agentLaunchConfigByPaneKey[session.cacheKey]
  const superseded =
    (kind === 'observer' && startup && decision && !matches) ||
    (currentStartup &&
      currentStartup !== context.paneStartup &&
      currentStartup.resumeSource !== startup?.resumeSource) ||
    (currentRegistration && currentRegistration !== context.registration) ||
    (state.agentStatusByPaneKey[session.cacheKey] &&
      state.agentStatusByPaneKey[session.cacheKey] !== context.status)
  try {
    if (
      rejected &&
      (!result.isReattach || result.agentResumeRefused) &&
      (matches || kind === 'candidate' || (kind === 'creator' && !result.isReattach))
    ) {
      session.cancelSavedResumeStartup(
        startup,
        candidateRejected ? { ...result, agentResumeRefused: 'unverifiable' } : result
      )
    }
  } catch (error) {
    console.warn('Terminal saved startup cancellation failed', error)
  }
  try {
    if (!superseded && kind !== 'candidate') {
      session.registerEffectiveLaunchConfig(result.launchConfig, {
        launchToken: result.launchToken,
        launchAgent:
          result.launchAgent ??
          (!rejected && !result.isReattach && startup && 'agent' in startup
            ? startup.agent
            : undefined)
      })
    }
  } catch (error) {
    // A bound shell remains usable even when exact-source bookkeeping fails.
    console.warn('Terminal launch result bookkeeping failed', error)
  }
  if (rejected && !superseded) {
    session.showSessionRestoredBanner('resume-unavailable')
  }
  return rejected
}
