import { useEffect, useState, useSyncExternalStore } from 'react'
import { translate } from '../../i18n/i18n'
import { useTranslate, type Translate } from '../../i18n/use-translate'
import { useClipboardTextCopyFeedback } from '../../hooks/clipboard/use-clipboard-text-copy-feedback'
import {
  antigravityChatSignInRunning as running,
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  observeAntigravityChatSignIn,
  readAntigravityChatSignIn,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIns,
  type AntigravityChatSignInView
} from '../../runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../../../shared/antigravity-account-types'

/** A running flow another client started: the host tells only its starter the id. */
const otherClients = (flow: AntigravityChatSignInState | null): boolean =>
  running(flow) && flow.flowId === null

/** Progress of a sign-in flow; signed-in or signed-out state shows in the status badge instead. */
function chatSignInLine(
  flow: AntigravityChatSignInState | null,
  auth: AntigravityChatAuth,
  openFailed: boolean,
  t: Translate = translate
): string | null {
  if (otherClients(flow)) {
    return t('accounts.antigravity.chatOtherClient', 'Sign-in is in progress in another client.')
  }
  switch (flow?.phase) {
    case 'starting':
      return t('accounts.antigravity.chatStarting', 'Starting sign-in…')
    case 'waiting':
      return openFailed
        ? t('accounts.antigravity.chatOpenFailed', 'Copy the link and open it in your browser.')
        : t('accounts.antigravity.chatWaiting', 'Finish signing in in your browser.')
    case 'verifying':
      return t('accounts.antigravity.chatVerifying', 'Finishing sign-in…')
    // A settled flow only stands in until the host answers whether it is signed in.
    case 'cancelled':
      return auth === 'unknown'
        ? t('accounts.antigravity.chatCancelled', 'Sign-in cancelled.')
        : null
    case 'expired':
      return auth === 'unknown'
        ? t('accounts.antigravity.chatExpired', 'Sign-in timed out. Try again.')
        : null
    case 'failed':
    case 'signedIn':
    case undefined:
      return null
  }
}

type SignInAction = 'retry' | 'changeAccount' | 'signIn'

function signInAction(
  flow: AntigravityChatSignInState | null,
  auth: AntigravityChatAuth,
  error: string | null
): SignInAction {
  if (
    error ||
    flow?.phase === 'failed' ||
    flow?.phase === 'cancelled' ||
    flow?.phase === 'expired'
  ) {
    return 'retry'
  }
  return auth === 'signedIn' ? 'changeAccount' : 'signIn'
}

const NOT_FOLLOWED: AntigravityChatSignInView = {
  status: 'unknown',
  flow: null,
  auth: 'unknown',
  error: null,
  openFailed: false
}

export function useAntigravityChatSignIn(
  owner: RuntimeClientTarget | null
): AntigravityChatSignInView {
  const shown = owner !== null
  const environmentId = owner?.kind === 'environment' ? owner.environmentId : null
  useEffect(
    () =>
      shown
        ? observeAntigravityChatSignIn(
            environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
          )
        : undefined,
    [shown, environmentId]
  )
  const read = (): AntigravityChatSignInView =>
    owner ? readAntigravityChatSignIn(owner) : NOT_FOLLOWED
  return useSyncExternalStore(subscribeAntigravityChatSignIns, read, read)
}

/** Share host auth across Settings layouts; auth stays unknown until a chat or sign-in asks the host. */
export type AntigravityChatSignInControls = ReturnType<typeof useAntigravityChatSignInControls>

export function useAntigravityChatSignInControls(props: {
  owner: RuntimeClientTarget
  label: string
  disabled: boolean
}) {
  const t = useTranslate()
  const { owner, label } = props
  const { status, flow, auth, openFailed, ...view } = useAntigravityChatSignIn(owner)
  const [pending, setPending] = useState(false)
  const act = (request: () => Promise<void>): void => {
    setPending(true)
    void request().finally(() => setPending(false))
  }
  const copy = useClipboardTextCopyFeedback(flow?.url ?? '')
  const failed = t('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')
  const error = view.error === null ? null : view.error || failed
  const copyFailed = t('accounts.antigravity.chatCopyFailed', 'Could not copy the link.')
  const readFailed = t(
    'accounts.antigravity.chatReadFailed',
    'Could not check the sign-in on {{host}}.',
    { host: label }
  )
  const ownFlow = running(flow) && flow.flowId !== null
  const action = signInAction(flow, auth, error)
  const line = status === 'known' ? chatSignInLine(flow, auth, openFailed, t) : null
  return {
    flow,
    auth: status === 'known' ? auth : 'unknown',
    signingIn: running(flow),
    ownFlow,
    url: ownFlow && flow?.phase === 'waiting' ? (flow.url ?? null) : null,
    line,
    alert:
      error ??
      (status === 'readFailed' ? readFailed : null) ??
      (flow?.phase === 'failed' ? (flow.error ?? failed) : null) ??
      (copy.status === 'failed' ? copyFailed : null),
    action,
    pending,
    copy,
    copyLabel: t('accounts.antigravity.chatCopyLink', 'Copy sign-in link'),
    signInDisabled: props.disabled || pending || status !== 'known' || otherClients(flow),
    recoveryDisabled: props.disabled || pending || otherClients(flow),
    start: () => act(() => startAntigravityChatSignIn(owner)),
    cancel: () => act(() => cancelAntigravityChatSignIn(owner)),
    send: (callbackUrl: string, refused: (message: string) => void) =>
      act(async () => {
        const refusal = await completeAntigravityChatSignIn(owner, callbackUrl)
        if (refusal !== null) {
          refused(refusal || failed)
        }
      })
  }
}
