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
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import { antigravityChatAuthMethodLabel } from '@/components/provider-accounts/AntigravityChatAuthMethodItems'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'

type Method = AntigravityChatAuthConfig['method']
/** An older Gemini Enterprise choice is agy's Google sign-in now. */
export type AntigravitySwitchableMethod = Exclude<Method, 'oauth-business'>

/** Where an Antigravity chat runs agy: on agy's own home, which keeps agy's login whatever method
 *  Orca saves, or on Orca's chat home, which follows the saved method. */
export type NativeChatAntigravityAuthTarget = {
  host: RuntimeClientTarget
  ownHome: boolean
  /** The version of Orca's installed agy, when the host has reported one. */
  managedVersion?: string | null
  /** The agy this chat runs is Orca's own copy, not the person's. */
  orcasAgy?: boolean
  /** Which agy runs this chat isn't known yet, so nothing names it. */
  programPending?: boolean
}

/** How an Antigravity chat signs in, and one-click ways to change it. */
export type NativeChatAntigravityAuth = {
  host: RuntimeClientTarget
  ownHome: boolean
  managedVersion: string | null
  orcasAgy: boolean
  programPending: boolean
  detection: AntigravityChatAuthDetection | null
  /** The host takes the Gemini API key and gcloud methods. */
  keyAndAdc: boolean
  /** The method being applied; every switch control waits while one is. */
  switching: Method | null
  switchTo: (method: AntigravitySwitchableMethod) => void
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

/** Applies `method` on the host and says how it went; never rejects. */
async function applyAntigravityChatAuthMethod(
  target: RuntimeClientTarget,
  method: AntigravitySwitchableMethod,
  t: Translate
): Promise<void> {
  try {
    // Keep a saved project and location across switches, as detection does.
    const saved = await callAntigravityChatAuthConfig(target)
    await callAntigravityChatAuthConfig(target, {
      method,
      ...(saved?.gcpProject ? { gcpProject: saved.gcpProject } : {}),
      ...(saved?.gcpLocation ? { gcpLocation: saved.gcpLocation } : {})
    })
    toast.success(
      t('components.native-chat.antigravityAuth.switched', 'Antigravity now uses {{method}}.', {
        method: antigravityChatAuthMethodLabel(method, t) ?? method
      })
    )
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
  const ownHome = target?.ownHome === true
  const managedVersion = target?.managedVersion ?? null
  const orcasAgy = target?.orcasAgy === true
  const programPending = target?.programPending === true
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
    (target: RuntimeClientTarget, action: AntigravitySwitchableMethod): Promise<void> => {
      if (busy.current) {
        return Promise.resolve()
      }
      busy.current = true
      setSwitching(action)
      return applyAntigravityChatAuthMethod(target, action, t).then(() => {
        busy.current = false
        setSwitching(null)
      })
    },
    [t]
  )

  // Applying stops the host's running chats, so re-read first: a chat may have started since
  // mount. An unanswered read can't rule chats out, so it asks too.
  const decide = useCallback(
    async (target: RuntimeClientTarget, action: AntigravitySwitchableMethod): Promise<void> => {
      if (busy.current) {
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
    [apply]
  )

  const value = useMemo((): NativeChatAntigravityAuth | null => {
    if (!host) {
      return null
    }
    return {
      host,
      ownHome,
      managedVersion,
      orcasAgy,
      programPending,
      detection,
      keyAndAdc,
      switching,
      switchTo: (method) => void decide(host, method),
      openSettings: () => openAntigravitySignInSettings(host),
      refresh: () => void refreshAntigravityChatAuthDetection(host, { force: true })
    }
  }, [
    host,
    ownHome,
    managedVersion,
    orcasAgy,
    programPending,
    detection,
    keyAndAdc,
    switching,
    decide
  ])

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
