import { AlertCircle } from 'lucide-react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'

/** Settings rows for how a host's chats sign in: the method and its key or project. agy's Google
 *  login, which a Google method uses, is in the account rows below them. */
export function AntigravityChatAuthRows(props: {
  owner: RuntimeClientTarget
  /** After the sign-in method saves, which moves new chats between agy's home and Orca's. */
  onSaved?: () => void
}): React.JSX.Element {
  return (
    <AntigravityChatAuthForm
      owner={props.owner}
      disabled={false}
      onSignIn={() => {}}
      heading={null}
      onSaved={props.onSaved}
      fieldsRow={(fields) => (
        <div data-settings-row="" className="py-3">
          {fields}
        </div>
      )}
    >
      {(auth) =>
        auth.alert ? (
          <div data-settings-row="" className="py-3">
            <span role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" />
              {auth.alert}
            </span>
          </div>
        ) : null
      }
    </AntigravityChatAuthForm>
  )
}
