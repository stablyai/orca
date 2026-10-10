import { useStructuredLaunchCreateSupport } from './structured-agent-session-launch-create-support'
import { takeBackLegacyStructuredLaunchPrompts } from './structured-agent-session-launch-prompt'

/** Stop takes the launch text back only when the host predates create carrying the first message. */
export function useStructuredLegacyLaunchStop(sessionId: string): {
  legacyLaunch?: { takeBackText: () => void }
} {
  return useStructuredLaunchCreateSupport(sessionId) === false
    ? { legacyLaunch: { takeBackText: () => takeBackLegacyStructuredLaunchPrompts(sessionId) } }
    : {}
}
