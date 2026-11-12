import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import { useTranslate } from '@/i18n/use-translate'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  AntigravityChatSignInAction,
  AntigravityChatSignInBadge
} from './AntigravityChatSignInAction'
import { antigravityChatSignInBlocked } from './antigravity-chat-runtime-sign-in-policy'
import { useAntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

type ActiveInstall = Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>

export function AntigravityProviderSignInArea(props: {
  owner: RuntimeClientTarget
  label: string
  install: ActiveInstall
}): React.JSX.Element {
  const t = useTranslate()
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    disabled: antigravityChatSignInBlocked(props.install)
  })
  return (
    <div className="space-y-3 border-y border-border py-3">
      <AntigravityChatAuthForm
        owner={props.owner}
        disabled={antigravityChatSignInBlocked(props.install) || signIn.ownFlow}
        onSignIn={signIn.start}
        signInError={signIn.alert}
        heading={
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium leading-none">
                {t('settings.chat.providers.antigravityAccount', 'Account')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('accounts.antigravity.chatSeparate', 'Separate from your agy terminal account.')}
              </p>
            </div>
            <AntigravityChatSignInBadge signIn={signIn} />
          </div>
        }
      >
        {(auth) => <AntigravityChatSignInAction signIn={signIn} auth={auth} size="sm" />}
      </AntigravityChatAuthForm>
    </div>
  )
}
