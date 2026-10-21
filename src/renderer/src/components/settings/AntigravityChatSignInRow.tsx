import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Check, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
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
} from '@/runtime/antigravity-chat-sign-in-status'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../../../shared/antigravity-account-types'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

type Flow = AntigravityChatSignInState

/** A running flow another client started: the host tells only its starter the id. */
const otherClients = (flow: Flow | null): boolean => running(flow) && flow.flowId === null

function authLine(auth: AntigravityChatAuth, host: string, signedOut: string): string | null {
  if (auth === 'signedIn') {
    return translate('accounts.antigravity.chatSignedInOn', 'Signed in on {{host}}.', { host })
  }
  return auth === 'signedOut' ? signedOut : null
}

function chatSignInLine(
  flow: Flow | null,
  auth: AntigravityChatAuth,
  openFailed: boolean,
  host: string,
  signedOut: string
): string | null {
  if (otherClients(flow)) {
    return translate(
      'accounts.antigravity.chatOtherClient',
      'Sign-in is in progress in another client.'
    )
  }
  switch (flow?.phase) {
    case 'starting':
      return translate('accounts.antigravity.chatStarting', 'Starting sign-in…')
    case 'waiting':
      return openFailed
        ? translate(
            'accounts.antigravity.chatOpenFailed',
            'Copy the link and open it in your browser.'
          )
        : translate('accounts.antigravity.chatWaiting', 'Finish signing in in your browser.')
    case 'verifying':
      return translate('accounts.antigravity.chatVerifying', 'Finishing sign-in…')
    // A settled flow only stands in until the host answers whether it is signed in.
    case 'cancelled':
      return (
        authLine(auth, host, signedOut) ??
        translate('accounts.antigravity.chatCancelled', 'Sign-in cancelled.')
      )
    case 'expired':
      return (
        authLine(auth, host, signedOut) ??
        translate('accounts.antigravity.chatExpired', 'Sign-in timed out. Try again.')
      )
    case 'failed':
    case 'signedIn':
    case undefined:
      return authLine(auth, host, signedOut)
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

const SIGN_IN_ACTION_LABELS: Record<SignInAction, () => string> = {
  retry: () => translate('accounts.antigravity.chatRetry', 'Retry sign-in'),
  changeAccount: () => translate('accounts.antigravity.chatChangeAccount', 'Change account'),
  signIn: () => translate('accounts.antigravity.chatSignIn', 'Sign in')
}

const SETTLED_OPERATION_PHASES = new Set(['succeeded', 'failed', 'cancelled'])

/** Sign-in runs the installed server, so it waits while the host reports nothing to run or a
 *  Remove still runs; an Update keeps the old copy running until it lands. The install row beside
 *  it says why. A status the host could not report leaves it to the host. */
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

/** The host's chat sign-in, followed while `owner` is set; the install row beside it reads it too. */
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

/** Google's last page points at the host, which a browser on another computer can't reach, so its
 *  address is pasted here and the host passes it on. */
export function PastedAddressForm(props: {
  pending: boolean
  send: (callbackUrl: string, refused: (message: string) => void) => void
}): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  // The host's refusal of this address; the form leaves once the host takes one.
  const [refusal, setRefusal] = useState<string | null>(null)
  const helpId = useId()
  const callbackUrl = pasted.trim()
  // noValidate: the browser's URL check would pre-empt the host's refusal, which says what's wrong.
  return (
    <form
      noValidate
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (callbackUrl) {
          props.send(callbackUrl, setRefusal)
        }
      }}
    >
      <p id={helpId} className="text-xs text-muted-foreground">
        {translate(
          'accounts.antigravity.chatPasteHelp',
          "If the last page after signing in doesn't load, copy its full address from your browser and paste it here."
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={16_384}
          aria-labelledby={helpId}
          aria-invalid={refusal !== null}
          value={pasted}
          disabled={props.pending}
          onChange={(event) => {
            setPasted(event.target.value)
            setRefusal(null)
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={props.pending || !callbackUrl}>
          {translate('accounts.antigravity.chatContinue', 'Continue')}
        </Button>
      </div>
      {refusal !== null && (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      )}
    </form>
  )
}

/** One host's chat sign-in as both Settings layouts show it. `signedOut` is the line for a host
 *  that answered it is not signed in; `unanswered` stands in while it has nothing else to say, as a
 *  host learns its sign-in only when a chat starts or asks to sign in. */
export function useAntigravityChatSignInControls(props: {
  owner: RuntimeClientTarget
  label: string
  signedOut: string
  unanswered?: string
  disabled: boolean
}) {
  const { owner, label } = props
  const { status, flow, auth, openFailed, ...view } = useAntigravityChatSignIn(owner)
  // One start, cancel or paste at a time, so a double click asks the host once.
  const [pending, setPending] = useState(false)
  const act = (request: () => Promise<void>): void => {
    setPending(true)
    void request().finally(() => setPending(false))
  }
  const copy = useClipboardTextCopyFeedback(flow?.url ?? '')
  const failed = translate('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')
  const error = view.error === null ? null : view.error || failed
  const copyFailed = translate('accounts.antigravity.chatCopyFailed', 'Could not copy the link.')
  const readFailed = translate(
    'accounts.antigravity.chatReadFailed',
    'Could not check the sign-in on {{host}}.',
    { host: label }
  )
  const ownFlow = running(flow) && flow.flowId !== null
  const action = signInAction(flow, auth, error)
  return {
    flow,
    ownFlow,
    /** The browser's link, while this client's sign-in waits on it. */
    url: ownFlow && flow?.phase === 'waiting' ? (flow.url ?? null) : null,
    line:
      status === 'known'
        ? (chatSignInLine(flow, auth, openFailed, label, props.signedOut) ??
          props.unanswered ??
          null)
        : null,
    alert:
      error ??
      (status === 'readFailed' ? readFailed : null) ??
      (flow?.phase === 'failed' ? (flow.error ?? failed) : null) ??
      (copy.status === 'failed' ? copyFailed : null),
    action,
    actionLabel: SIGN_IN_ACTION_LABELS[action](),
    pending,
    copy,
    copyLabel: translate('accounts.antigravity.chatCopyLink', 'Copy sign-in link'),
    signInDisabled: props.disabled || pending || status !== 'known' || otherClients(flow),
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

/** This execution host's sign-in for Antigravity chats, run by the host's own server. Every row
 *  for a host shows the same sign-in, a running one included. */
export function AntigravityChatSignInRow(props: {
  owner: RuntimeClientTarget
  label: string
  description: string
  disabled: boolean
}): React.JSX.Element {
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    signedOut: translate('accounts.antigravity.chatNotSignedIn', 'Not signed in on {{host}}.', {
      host: props.label
    }),
    disabled: props.disabled
  })
  const { line, alert, copy, copyLabel, url } = signIn
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-none">
            {translate('accounts.antigravity.chatTitle', 'Antigravity chats')}
          </p>
          {props.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
          ) : null}
          {/* The line keeps its height until the host answers, so nothing shifts when it does. */}
          <p role="status" className="mt-1 min-h-4 break-words text-xs text-muted-foreground">
            {line}
            {line && alert ? ' ' : null}
            {alert && (
              <span role="alert" className="text-destructive">
                {alert}
              </span>
            )}
          </p>
        </div>
        {signIn.ownFlow ? (
          <div className="flex shrink-0 items-center gap-2">
            {url && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={copyLabel}
                    onClick={() => void copy.copyText()}
                  >
                    {copy.status === 'copied' ? <Check /> : <Copy />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copyLabel}</TooltipContent>
              </Tooltip>
            )}
            <Button size="xs" variant="ghost" disabled={signIn.pending} onClick={signIn.cancel}>
              {translate('accounts.antigravity.chatCancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button
            size="xs"
            // Signed in, the button only switches account, so it steps back from the primary.
            variant={signIn.action === 'changeAccount' ? 'outline' : 'default'}
            disabled={signIn.signInDisabled}
            onClick={signIn.start}
          >
            {signIn.actionLabel}
          </Button>
        )}
      </div>
      {url && <PastedAddressForm pending={signIn.pending} send={signIn.send} />}
    </div>
  )
}
