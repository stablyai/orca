import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
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
  useAntigravityChatAuthDetection
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
import { startAntigravityChatSignIn } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
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
export type NativeChatAntigravityAuthTarget = {
  host: RuntimeClientTarget
  backend: 'managed' | 'agy'
}

/** How an Antigravity chat signs in, and one-click ways to change it. */
export type NativeChatAntigravityAuth = {
  host: RuntimeClientTarget
  backend: NativeChatAntigravityAuthTarget['backend']
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

const isGoogle = (method: Method | null | undefined): boolean =>
  method === 'oauth-personal' || method === 'oauth-business'

/** Applies `method` on the host and says how it went; never rejects. */
async function applyAntigravityChatAuthMethod(
  target: RuntimeClientTarget,
  method: AntigravitySwitchableMethod,
  t: Translate
): Promise<void> {
  try {
    await callAntigravityChatAuthConfig(target, { method })
    // A Google method with no saved sign-in has nothing to use until Google signs it in.
    if (isGoogle(method) && !readAntigravityChatAuthDetection(target)?.googleSignIn) {
      await startAntigravityChatSignIn(target)
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
  const backend = target?.backend ?? 'managed'
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
  const [confirming, setConfirming] = useState<AntigravitySwitchableMethod | null>(null)
  const busy = useRef(false)

  const apply = useCallback(
    (target: RuntimeClientTarget, method: AntigravitySwitchableMethod): Promise<void> => {
      if (busy.current) {
        return Promise.resolve()
      }
      busy.current = true
      setSwitching(method)
      return applyAntigravityChatAuthMethod(target, method, t).then(() => {
        busy.current = false
        setSwitching(null)
      })
    },
    [t]
  )

  const value = useMemo((): NativeChatAntigravityAuth | null => {
    if (!host) {
      return null
    }
    return {
      host,
      backend,
      detection,
      keyAndAdc,
      switching,
      // Applying stops the host's running Antigravity chats, so ask first when any would stop.
      switchTo: (method) =>
        detection && detection.liveChats > 0 && method !== detection.method
          ? setConfirming(method)
          : void apply(host, method),
      signInWithGoogle: () =>
        isGoogle(detection?.method)
          ? void startAntigravityChatSignIn(host)
          : void apply(host, 'oauth-personal'),
      openSettings: () => openAntigravitySignInSettings(host),
      refresh: () => void refreshAntigravityChatAuthDetection(host, { force: true })
    }
  }, [host, backend, detection, keyAndAdc, switching, apply])

  const confirmLabel = confirming ? (antigravityChatAuthMethodLabel(confirming, t) ?? '') : ''
  return (
    <NativeChatAntigravityAuthContext value={value}>
      {children}
      {host && (
        <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>
                {t('components.native-chat.antigravityAuth.confirmTitle', 'Switch to {{method}}?', {
                  method: confirmLabel
                })}
              </DialogTitle>
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
                  const method = confirming
                  setConfirming(null)
                  if (method) {
                    void apply(host, method)
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
