import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import type { ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AntigravityChatAccountRow } from './AntigravityChatSignInAction'
import { useAntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

/** Settings rows for an execution host's chat sign-in; every client of the host shares its server's sign-in, including running flows. */
export function AntigravityChatSignInRow(props: {
  owner: RuntimeClientTarget
  label: string
  disabled: boolean
  /** The chat server's install row, last because it is set up once. */
  runtime?: ReactNode
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
        fieldsRow={(fields) => (
          <div data-settings-row="" className="py-3">
            {fields}
          </div>
        )}
      >
        {(auth) => <AntigravityChatAccountRow signIn={signIn} auth={auth} />}
      </AntigravityChatAuthForm>
      {props.runtime}
    </>
  )
}
