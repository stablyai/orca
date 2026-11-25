import { useMemo } from 'react'
import { useAntigravityChatSignIn } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import { isAntigravityGoogleMethod } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatAuthDetection } from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
import {
  antigravityChatSignInRunning,
  startAntigravityChatSignIn
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatSignIn } from './native-chat-host-setup-view'

/** Signs agy in from the chat where its own login serves it: on agy's home (`system`), or on a
 *  Google method. The sign-in strip then shows Google's link and takes the code. */
export function useNativeChatAgySignIn(
  agent: string,
  account: AgentSessionAccountKind | undefined,
  target: RuntimeClientTarget
): NativeChatSignIn | null {
  const antigravity = agent === 'antigravity'
  const method = useAntigravityChatAuthDetection(antigravity ? target : null)?.method
  const shown = antigravity && (account === 'system' || isAntigravityGoogleMethod(method))
  const view = useAntigravityChatSignIn(shown ? target : null)
  const signingIn = antigravityChatSignInRunning(view.flow)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  return useMemo(() => {
    if (!shown) {
      return null
    }
    const host: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    return { signingIn, signIn: () => void startAntigravityChatSignIn(host, 'signIn') }
  }, [shown, environmentId, signingIn])
}
