import { create } from 'zustand'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AgentSessionCodexVoices } from '../../../../../shared/agent-session/agent-session-voice-conversation'

type CodexVoiceSource = { target: RuntimeClientTarget; sessionId: string }

/** The voices the most recent Codex chat listed, which may not be the chat in view; the host
 *  re-checks the choice against its own Codex at start. */
export const useCodexVoiceCatalog = create<{
  voices: readonly string[] | null
  /** The last Codex chat shown, asked again on refresh: its child may have started since. */
  source: CodexVoiceSource | null
  listing: boolean
}>(() => ({ voices: null, source: null, listing: false }))

let latestListing = 0

export function noteCodexVoiceSource(source: CodexVoiceSource): void {
  useCodexVoiceCatalog.setState({ source })
  void refreshCodexVoiceCatalog()
}

export async function refreshCodexVoiceCatalog(): Promise<void> {
  const { source } = useCodexVoiceCatalog.getState()
  if (!source) {
    return
  }
  // A slower answer from an earlier chat or host must not replace a newer listing.
  const listing = ++latestListing
  useCodexVoiceCatalog.setState({ listing: true })
  try {
    const { voices } = await callStructuredAgentSession<AgentSessionCodexVoices>(
      source.target,
      'agentSession.codexVoices',
      { sessionId: source.sessionId }
    )
    if (listing === latestListing && voices && voices.length > 0) {
      useCodexVoiceCatalog.setState({ voices })
    }
  } catch {
    // A resting chat or an unreachable host lists nothing; the last listing stays.
  } finally {
    if (listing === latestListing) {
      useCodexVoiceCatalog.setState({ listing: false })
    }
  }
}
