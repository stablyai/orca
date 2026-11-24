import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import type { ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { AntigravityChatAccountRow } from './AntigravityChatSignInAction'
import { useAntigravityChatSignInControls } from './use-antigravity-chat-sign-in'
import { isAntigravityGoogleMethod } from './antigravity-chat-runtime-sign-in-policy'

/** Settings rows for a host's chat sign-in method and, on a Google method, agy's own login, which
 *  every client of the host shares, running flows included. */
export function AntigravityChatSignInRow(props: {
  owner: RuntimeClientTarget
  label: string
  /** Sign-in runs agy, which isn't installed or is changing. */
  signInDisabled: boolean
  /** agy's install row, last because it is set up once. */
  runtime?: ReactNode
  /** After the sign-in method saves, which moves new chats between agy's home and Orca's. */
  onSaved?: () => void
}): React.JSX.Element {
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    disabled: props.signInDisabled
  })
  return (
    <>
      <AntigravityChatAuthForm
        owner={props.owner}
        disabled={signIn.ownFlow}
        onSignIn={signIn.start}
        signInError={signIn.alert}
        heading={null}
        onSaved={props.onSaved}
        fieldsRow={(fields) => (
          <div data-settings-row="" className="py-3">
            {fields}
          </div>
        )}
      >
        {(auth) =>
          // A key or gcloud never uses agy's Google login, so only a failure shows for them.
          isAntigravityGoogleMethod(auth.pickedMethod) || auth.alert ? (
            <AntigravityChatAccountRow signIn={signIn} auth={auth} />
          ) : null
        }
      </AntigravityChatAuthForm>
      {props.runtime}
    </>
  )
}
