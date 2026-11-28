import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from 'react'
import { toast } from 'sonner'
import { useNativeChatViewGuard } from '../pane/ownership/native-chat-view-memory'
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
import { isAntigravityGoogleMethod } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'

type Method = AntigravityChatAuthConfig['method']
/** Gemini Enterprise needs a project and location, which only Settings collects. */
export type AntigravitySwitchableMethod = Exclude<Method, 'oauth-business'>

/** An Antigravity chat's host and which agy runs its chats there. */
export type NativeChatAntigravityAuthTarget = {
  host: RuntimeClientTarget
  /** Orca's installed agy or the person's own; null until the host says, or while none is. */
  agy: 'orcas' | 'yours' | null
  /** The version of Orca's installed agy, when the host has reported one. */
  managedVersion: string | null
  /** This chat runs on agy's own home and Google login, whatever method new chats use. */
  ownLogin: boolean
}

/** How an Antigravity chat signs in, and one-click ways to change it. */
export type NativeChatAntigravityAuth = NativeChatAntigravityAuthTarget & {
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

/** Null outside an Antigravity chat. */
export function useNativeChatAntigravityAuth(): NativeChatAntigravityAuth | null {
  return useContext(NativeChatAntigravityAuthContext)
}

const subscribeToNothing = (): (() => void) => () => {}

/** Signs agy in with Google, keeping the saved method. */
const GOOGLE_SIGN_IN = 'google-sign-in'
type AuthAction = AntigravitySwitchableMethod | typeof GOOGLE_SIGN_IN

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
    // agy without a Google login has nothing to use until it signs in.
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
  const hostProp = target?.host ?? null
  const agy = target?.agy ?? null
  const managedVersion = target?.managedVersion ?? null
  const ownLogin = target?.ownLogin === true
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
  // Kept with the chat tab: a view released mid-switch returns still switching, so it can't start another.
  const [switching, setSwitching, readSwitching] = useNativeChatViewGuard<Method | null>(
    'antigravity-auth-switch',
    null
  )
  const [confirming, setConfirming] = useState<AntigravitySwitchableMethod | null>(null)

  const apply = useCallback(
    (target: RuntimeClientTarget, action: AuthAction): Promise<void> => {
      if (readSwitching() !== null) {
        return Promise.resolve()
      }
      setSwitching(action === GOOGLE_SIGN_IN ? 'oauth-personal' : action)
      const done =
        action === GOOGLE_SIGN_IN
          ? startAntigravityChatSignIn(target, 'signIn')
          : applyAntigravityChatAuthMethod(target, action, t)
      return done.then(() => setSwitching(null))
    },
    [t, readSwitching, setSwitching]
  )

  // A switch restarts the host's running chats, so re-read first: a chat may have started since
  // mount. An unanswered read can't rule chats out, so it asks too. Signing agy in restarts none.
  const decide = useCallback(
    async (target: RuntimeClientTarget, action: AuthAction): Promise<void> => {
      if (readSwitching() !== null) {
        return
      }
      if (action === GOOGLE_SIGN_IN) {
        await apply(target, action)
        return
      }
      const answered = await refreshAntigravityChatAuthDetection(target, { force: true })
      // A failed re-read leaves an old count, which can't rule out chats started since.
      const current = answered ? readAntigravityChatAuthDetection(target) : null
      if (current?.method === action) {
        return
      }
      if (!current || current.liveChats > 0) {
        setConfirming(action)
        return
      }
      await apply(target, action)
    },
    [apply, readSwitching]
  )

  // A sign-in or a method saved elsewhere (Settings, another client) changes what's detected.
  useAntigravityChatSignIn(host)
  // Panes with no Antigravity host (every other agent's) skip the store's publications.
  const signInRevision = useSyncExternalStore(
    host ? subscribeAntigravityChatSignIns : subscribeToNothing,
    () => {
      const snapshot = host ? readAntigravityChatSignInSnapshot(host) : null
      return snapshot?.kind === 'known' ? snapshot.state.revision : -1
    }
  )
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
      agy,
      managedVersion,
      ownLogin,
      detection,
      keyAndAdc,
      switching,
      switchTo: (method) => void decide(host, method),
      // Without a detection (older host, first read out) the saved method is unknown: only sign in.
      signInWithGoogle: () =>
        void decide(
          host,
          !detection?.method || isAntigravityGoogleMethod(detection.method)
            ? GOOGLE_SIGN_IN
            : 'oauth-personal'
        ),
      openSettings: () => openAntigravitySignInSettings(host),
      refresh: () => void refreshAntigravityChatAuthDetection(host, { force: true })
    }
  }, [host, agy, managedVersion, ownLogin, detection, keyAndAdc, switching, decide])

  const confirmTitle = t(
    'components.native-chat.antigravityAuth.confirmTitle',
    'Switch to {{method}}?',
    {
      method: confirming ? (antigravityChatAuthMethodLabel(confirming, t) ?? '') : ''
    }
  )
  return (
    <NativeChatAntigravityAuthContext value={value}>
      {children}
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
