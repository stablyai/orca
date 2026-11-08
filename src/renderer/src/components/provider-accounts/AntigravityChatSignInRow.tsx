import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import {
  antigravityChatSignInRunning as running,
  cancelAntigravityChatSignIn,
  completeAntigravityChatSignIn,
  observeAntigravityChatSignIn,
  readAntigravityChatSignIn,
  startAntigravityChatSignIn,
  subscribeAntigravityChatSignIns,
  type AntigravityChatSignInView
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../../../shared/antigravity-account-types'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import {
  AntigravityChatSignInAction,
  AntigravityChatSignInBadge
} from './AntigravityChatSignInAction'

type Flow = AntigravityChatSignInState

/** A running flow another client started: the host tells only its starter the id. */
const otherClients = (flow: Flow | null): boolean => running(flow) && flow.flowId === null

/** Progress of a sign-in flow; signed-in or signed-out state shows in the status badge instead. */
function chatSignInLine(
  flow: Flow | null,
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
  flow: Flow | null,
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

const SETTLED_OPERATION_PHASES = new Set(['succeeded', 'failed', 'cancelled'])

/** Sign-in needs an installed server and no removal; updates keep the old copy usable, while unreported status defers to the host. */
export function antigravityChatSignInBlocked(
  install: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return snapshot.kind === 'unknown'
  }
  const { source, operation } = snapshot.state
  return !source || (operation?.kind === 'remove' && !SETTLED_OPERATION_PHASES.has(operation.phase))
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

/** All rows for an execution host share its server’s sign-in, including running flows. */
export function AntigravityChatSignInRow(props: {
  owner: RuntimeClientTarget
  label: string
  description: string
  disabled: boolean
  /** The chat server's install row, shown above sign-in because sign-in needs it. */
  runtime?: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    disabled: props.disabled
  })
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <AntigravityChatAuthForm
        owner={props.owner}
        disabled={props.disabled || signIn.ownFlow}
        onSignIn={signIn.start}
        signInError={signIn.alert}
        heading={
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium leading-none">
                  {t('accounts.antigravity.chatTitle', 'Antigravity chats')}
                </p>
                {props.description ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">{props.description}</p>
                ) : null}
              </div>
              <AntigravityChatSignInBadge signIn={signIn} />
            </div>
            {props.runtime}
          </>
        }
      >
        {(auth) => <AntigravityChatSignInAction signIn={signIn} auth={auth} size="default" />}
      </AntigravityChatAuthForm>
    </div>
  )
}
