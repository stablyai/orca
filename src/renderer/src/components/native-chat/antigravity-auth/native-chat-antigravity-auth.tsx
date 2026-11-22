import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { callAntigravityChatAuthConfig } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import {
  readAntigravityChatAuthDetection,
  refreshAntigravityChatAuthDetection,
  refreshAntigravityChatAuthDetectionAt,
  useAntigravityChatAuthDetection
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
import {
  readAntigravityChatSignInSnapshot,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIns
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import { useAntigravityChatSignIn } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import { antigravityChatAuthMethodLabel } from '@/components/provider-accounts/AntigravityChatAuthMethodItems'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'

type Method = AntigravityChatAuthConfig['method']
/** Gemini Enterprise needs a project and location, which only Settings collects. */
export type AntigravitySwitchableMethod = Exclude<Method, 'oauth-business'>

/** Where an Antigravity chat runs: Orca's managed server, or the host's own `agy acp`, which
 *  keeps agy's login whatever method Orca saves. */
type NativeChatAntigravityAccountTarget = {
  host: RuntimeClientTarget
  backend: 'managed' | 'agy'
  /** The version of Orca's installed copy, when the host has reported one. */
  managedVersion?: string | null
  /** The agy this chat runs is Orca's own copy, not the person's. */
  orcasAgy?: boolean
  /** Which agy runs this chat isn't known yet, so nothing names it. */
  programPending?: boolean
}

export type NativeChatAntigravityAuthTarget =
  | NativeChatAntigravityAccountTarget
  | { backend: 'pinned-server' }

/** How an Antigravity chat signs in, and one-click ways to change it. */
export type NativeChatAntigravityAuth = {
  host: RuntimeClientTarget
  backend: NativeChatAntigravityAccountTarget['backend']
  managedVersion: string | null
  orcasAgy: boolean
  programPending: boolean
  detection: AntigravityChatAuthDetection | null
  /** The host takes the Gemini API key and gcloud methods. */
  keyAndAdc: boolean
  /** The method being applied; every switch control waits while one is. */
  switching: Method | null
  switchTo: (method: AntigravitySwitchableMethod) => void
  signInWithGoogle: () => void
  openSettings: () => void
  refresh: () => void
}

/** Exported for fixtures; chats use the provider below. */
export const NativeChatAntigravityAuthContext = createContext<NativeChatAntigravityAuth | null>(
  null
)

export const NativeChatPinnedAntigravityServerContext = createContext(false)

/** Null outside an Antigravity chat. */
export function useNativeChatAntigravityAuth(): NativeChatAntigravityAuth | null {
  return useContext(NativeChatAntigravityAuthContext)
}

/** Starts Google sign-in on the saved Google method without changing it. */
const GOOGLE_SIGN_IN = 'google-sign-in'
type AuthAction = AntigravitySwitchableMethod | typeof GOOGLE_SIGN_IN

const isGoogle = (method: Method | null | undefined): boolean =>
  method === 'oauth-personal' || method === 'oauth-business'

/** Applies `method` on the host and says how it went; never rejects. */
async function applyAntigravityChatAuthMethod(
  target: RuntimeClientTarget,
  method: AntigravitySwitchableMethod,
  t: Translate
): Promise<void> {
  try {
    // Keep a saved project and location across switches, as detection does; Enterprise's
    // project is its license's, not one gcloud should use.
    const current = await callAntigravityChatAuthConfig(target)
    const saved = current?.method === 'oauth-business' ? null : current
    await callAntigravityChatAuthConfig(target, {
      method,
      ...(saved?.gcpProject ? { gcpProject: saved.gcpProject } : {}),
      ...(saved?.gcpLocation ? { gcpLocation: saved.gcpLocation } : {})
    })
    // Google sign-in with no saved token has nothing to use until Google signs it in.
    if (
      method === 'oauth-personal' &&
      !readAntigravityChatAuthDetection(target)?.googleSignIn.personal
    ) {
      await startAntigravityChatSignIn(target, 'signIn')
    } else {
      toast.success(
        t('components.native-chat.antigravityAuth.switched', 'Antigravity now uses {{method}}.', {
          method: antigravityChatAuthMethodLabel(method, t) ?? method
        })
      )
    }
  } catch (cause) {
    toast.error(
      cause instanceof Error && cause.message
        ? cause.message
        : t(
            'components.native-chat.antigravityAuth.switchFailed',
            "Orca couldn't change how Antigravity signs in. Try again."
          )
    )
  }
  void refreshAntigravityChatAuthDetection(target, { force: true })
}

/** Offers detections on the chat's host; null keeps every surface quiet (other agents). */
export function NativeChatAntigravityAuthProvider({
  target,
  children
}: {
  target: NativeChatAntigravityAuthTarget | null
  children: React.ReactNode
}): React.JSX.Element {
  const pinnedServer = target?.backend === 'pinned-server'
  const accountTarget = pinnedServer ? null : target
  const hostProp = accountTarget?.host ?? null
  const backend = accountTarget?.backend ?? 'managed'
  const managedVersion = accountTarget?.managedVersion ?? null
  const orcasAgy = accountTarget?.orcasAgy === true
  const programPending = accountTarget?.programPending === true
  const t = useTranslate()
  // Callers rebuild the target each render; one per host keeps the context value steady.
  const shown = hostProp !== null
  const environmentId = hostProp?.kind === 'environment' ? hostProp.environmentId : null
  const host = useMemo(
    (): RuntimeClientTarget | null =>
      !shown
        ? null
        : environmentId === null
          ? { kind: 'local' }
          : { kind: 'environment', environmentId },
    [shown, environmentId]
  )
  const detection = useAntigravityChatAuthDetection(host)
  const keyAndAdc =
    useStructuredAgentSessionHostCapabilityState(
      host,
      ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY
    ) === 'supported'
  const [switching, setSwitching] = useState<Method | null>(null)
  const [confirming, setConfirming] = useState<AuthAction | null>(null)
  const busy = useRef(false)

  const apply = useCallback(
    (target: RuntimeClientTarget, action: AuthAction): Promise<void> => {
      if (busy.current) {
        return Promise.resolve()
      }
      busy.current = true
      setSwitching(action === GOOGLE_SIGN_IN ? 'oauth-personal' : action)
      const done =
        action === GOOGLE_SIGN_IN
          ? startAntigravityChatSignIn(target, 'signIn')
          : applyAntigravityChatAuthMethod(target, action, t)
      return done.then(() => {
        busy.current = false
        setSwitching(null)
      })
    },
    [t]
  )

  // Applying and signing in both stop the host's running chats, so re-read first: a chat may
  // have started since mount. An unanswered read can't rule chats out, so it asks too.
  const decide = useCallback(
    async (target: RuntimeClientTarget, action: AuthAction): Promise<void> => {
      if (busy.current) {
        return
      }
      const answered = await refreshAntigravityChatAuthDetection(target, { force: true })
      // A failed re-read leaves an old count, which can't rule out chats started since.
      const current = answered ? readAntigravityChatAuthDetection(target) : null
      if (action !== GOOGLE_SIGN_IN && current?.method === action) {
        return
      }
      if (!current || current.liveChats > 0) {
        setConfirming(action)
        return
      }
      await apply(target, action)
    },
    [apply]
  )

  // A sign-in or a method saved elsewhere (Settings, another client) changes what's detected.
  useAntigravityChatSignIn(host)
  const signInRevision = useSyncExternalStore(subscribeAntigravityChatSignIns, () => {
    const snapshot = host ? readAntigravityChatSignInSnapshot(host) : null
    return snapshot?.kind === 'known' ? snapshot.state.revision : -1
  })
  useEffect(() => {
    if (host) {
      refreshAntigravityChatAuthDetectionAt(host, signInRevision)
    }
  }, [host, signInRevision])

  const value = useMemo((): NativeChatAntigravityAuth | null => {
    if (!host) {
      return null
    }
    return {
      host,
      backend,
      managedVersion,
      orcasAgy,
      programPending,
      detection,
      keyAndAdc,
      switching,
      switchTo: (method) => void decide(host, method),
      // Without a detection (older host, first read out) the saved method is unknown: only sign in.
      signInWithGoogle: () =>
        void decide(
          host,
          !detection?.method || isGoogle(detection.method) ? GOOGLE_SIGN_IN : 'oauth-personal'
        ),
      openSettings: () => openAntigravitySignInSettings(host),
      refresh: () => void refreshAntigravityChatAuthDetection(host, { force: true })
    }
  }, [
    host,
    backend,
    managedVersion,
    orcasAgy,
    programPending,
    detection,
    keyAndAdc,
    switching,
    decide
  ])

  const confirmTitle =
    confirming === GOOGLE_SIGN_IN
      ? t('components.native-chat.antigravityAuth.confirmSignIn', 'Sign in with Google?')
      : t('components.native-chat.antigravityAuth.confirmTitle', 'Switch to {{method}}?', {
          method: confirming ? (antigravityChatAuthMethodLabel(confirming, t) ?? '') : ''
        })
  return (
    <NativeChatAntigravityAuthContext value={value}>
      <NativeChatPinnedAntigravityServerContext value={pinnedServer}>
        {children}
      </NativeChatPinnedAntigravityServerContext>
      {host && (
        <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>{confirmTitle}</DialogTitle>
              <DialogDescription>
                {t(
                  'components.native-chat.antigravityAuth.confirmBody',
                  'Antigravity chats running on this host restart. A reply in progress stops; your conversations stay.'
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                {t('components.native-chat.antigravityAuth.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const action = confirming
                  setConfirming(null)
                  if (action) {
                    void apply(host, action)
                  }
                }}
              >
                {t('components.native-chat.antigravityAuth.confirm', 'Switch')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </NativeChatAntigravityAuthContext>
  )
}
