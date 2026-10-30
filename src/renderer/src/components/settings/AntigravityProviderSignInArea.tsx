import { Check, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import {
  PastedAddressForm,
  antigravityChatSignInBlocked,
  useAntigravityChatSignInControls
} from './AntigravityChatSignInRow'

type ActiveInstall = Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>

const CHANGING_PHASES = new Set(['downloading', 'extracting', 'verifying', 'removing'])

/** Require an installed server outside install/removal; retain space while host status is unknown. */
export function antigravityProviderSignInShown(install: ActiveInstall): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return true
  }
  const { source, operation } = snapshot.state
  return source !== null && !(operation && CHANGING_PHASES.has(operation.phase))
}

export function AntigravityProviderSignInArea(props: {
  owner: RuntimeClientTarget
  label: string
  install: ActiveInstall
}): React.JSX.Element {
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    signedOut: translate(
      'settings.chat.providers.antigravityNotSignedIn',
      'Not signed in. Chats need an Antigravity sign-in, separate from your agy terminal account.'
    ),
    unanswered: translate(
      'settings.chat.providers.antigravitySignInNeeded',
      'Chats need an Antigravity sign-in, separate from your agy terminal account.'
    ),
    disabled: antigravityChatSignInBlocked(props.install)
  })
  const { alert, copy, copyLabel, ownFlow, url } = signIn
  // A settled failure says only why; a running sign-in keeps its step beside a copy failure.
  const line = alert && !ownFlow ? null : signIn.line
  return (
    <div className="ml-10 space-y-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-none">
            {translate('settings.chat.providers.antigravityAccount', 'Account')}
          </p>
          {/* Reserve line height so the host’s answer cannot shift layout. */}
          <div
            role="status"
            className="mt-1 flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground"
          >
            {ownFlow ? <LoadingSpinner className="size-3 shrink-0" /> : null}
            <span className="min-w-0 break-words">
              {line}
              {line && alert ? ' ' : null}
              {alert && (
                <span role="alert" className="text-destructive">
                  {alert}
                </span>
              )}
            </span>
          </div>
        </div>
        {ownFlow ? (
          <div className="flex shrink-0 items-center gap-1">
            {url && (
              <Button size="xs" variant="ghost" onClick={() => void copy.copyText()}>
                {copy.status === 'copied' ? <Check /> : <Copy />}
                {copyLabel}
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={signIn.pending} onClick={signIn.cancel}>
              {translate('accounts.antigravity.chatCancel', 'Cancel')}
            </Button>
          </div>
        ) : (
          <Button
            size="xs"
            // Account switching uses secondary styling once signed in.
            variant={signIn.action === 'changeAccount' ? 'ghost' : 'outline'}
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
