import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import type { AntigravityGoogleSignInState } from './AntigravityGoogleSignInChoice'
import type { ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { AntigravityChatAccountRow } from './AntigravityChatSignInAction'
import { useAntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

/** Settings rows for an execution host's chat sign-in; every client of the host shares its server's sign-in, including running flows. */
export function AntigravityChatSignInRow(props: {
  owner: RuntimeClientTarget
  label: string
  disabled: boolean
  /** The chat server's install row, last because it is set up once. */
  runtime?: ReactNode
  /** The Google sign-in choice's state from the host's answer. */
  googleSignIn?: AntigravityGoogleSignInState
  /** After the sign-in method saves; the host's answer about the route is read again. */
  onSaved?: () => void
  /** Hide the server's account row unless it carries an error or a sign-in: Gemini API key chats
   *  run on agy, which Orca doesn't sign in. */
  noServerAccount?: boolean
}): React.JSX.Element {
  const signIn = useAntigravityChatSignInControls({
    owner: props.owner,
    label: props.label,
    disabled: props.disabled
  })
  return (
    <>
      <AntigravityChatAuthForm
        owner={props.owner}
        disabled={props.disabled || signIn.ownFlow}
        onSignIn={signIn.start}
        signInError={signIn.alert}
        heading={null}
        googleSignIn={props.googleSignIn}
        onSaved={props.onSaved}
        fieldsRow={(fields) => (
          <div data-settings-row="" className="py-3">
            {fields}
          </div>
        )}
      >
        {(auth) =>
          // On agy the server's account says nothing, but a failed save, or a method that signs in
          // picked here, still needs its message and button.
          props.noServerAccount && !auth.alert && !auth.reauth ? null : (
            <AntigravityChatAccountRow signIn={signIn} auth={auth} />
          )
        }
      </AntigravityChatAuthForm>
      {props.runtime}
    </>
  )
}
