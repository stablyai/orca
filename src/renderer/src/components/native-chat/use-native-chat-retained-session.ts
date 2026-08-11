import { useEffect, useRef } from 'react'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from '../../../../shared/native-chat-transcript-retention'
import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

/** Keeps one committed conversation visible while its exact source rebinds. */
export function useNativeChatRetainedSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const session = useNativeChatLiveSession(args)
  const identity = encodeNativeChatTranscriptIdentity([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null
  ])
  const activeIdentityRef = useRef(identity)
  const retentionRef = useRef(createNativeChatTranscriptRetention())
  const sessionMatchesIdentity = activeIdentityRef.current === identity
  const readPhase = sessionMatchesIdentity ? session.readPhase : 'loading'

  useEffect(() => {
    activeIdentityRef.current = identity
  }, [identity])
  useEffect(() => {
    if (sessionMatchesIdentity && args.sessionId !== null && session.readPhase === 'ready') {
      retentionRef.current.capture(identity, session.messages)
    }
  }, [args.sessionId, identity, session.messages, session.readPhase, sessionMatchesIdentity])

  const messages = retentionRef.current.visible({
    identity,
    messages: session.messages,
    settled: readPhase === 'ready',
    loading: readPhase === 'loading'
  })
  if (messages === session.messages && readPhase === session.readPhase) {
    return session
  }
  return {
    ...session,
    messages,
    readPhase,
    ...(sessionMatchesIdentity ? {} : { status: 'loading' as const, error: undefined })
  }
}
