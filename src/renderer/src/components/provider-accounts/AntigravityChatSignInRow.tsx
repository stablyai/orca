import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import type { ReactNode } from 'react'
import { useTranslate } from '../../i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  AntigravityChatSignInAction,
  AntigravityChatSignInBadge
} from './AntigravityChatSignInAction'
import { useAntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

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
