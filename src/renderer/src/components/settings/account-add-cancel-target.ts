import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  cancelHostAccountSignIn,
  isLostHostAnswer
} from '@/runtime/runtime-host-account-sign-in-client'
import type { HostAccountSignInProvider } from '../../../../shared/host-account-sign-in-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

type Addition = { target: RuntimeClientTarget }

/** Track each running addition’s original host so header Cancel follows sign-in even after Settings host navigation. */
const additions = new Map<HostAccountSignInProvider, Addition>()

export function trackAccountAddition<T>(
  provider: HostAccountSignInProvider,
  target: RuntimeClientTarget,
  run: () => Promise<T>
): Promise<T> {
  const addition: Addition = { target }
  additions.set(provider, addition)
  return run().finally(() => {
    if (additions.get(provider) === addition) {
      additions.delete(provider)
    }
  })
}

/** A Cancel the server could not be told about yet; the sign-in keeps asking it to stop. */
export function showHostCancelFailure(error: unknown): void {
  // Only lost replies need warning; refusals mean the flow already ended and the pane explains it.
  if (!isLostHostAnswer(error)) {
    return
  }
  toast.error(
    translate('accounts.hostSignIn.cancelFailed', 'Could not reach the server to cancel yet.'),
    { description: error instanceof Error ? error.message : String(error) }
  )
}

export function cancelAccountAddition(
  provider: HostAccountSignInProvider,
  cancelLocal: () => Promise<unknown>
): Promise<unknown> {
  const target = additions.get(provider)?.target
  return target?.kind === 'environment'
    ? cancelHostAccountSignIn(target, provider).catch(showHostCancelFailure)
    : cancelLocal()
}

/** True when the shown host's own sign-in prompt already offers this addition's Cancel. */
export function accountAdditionShownInPrompt(
  provider: HostAccountSignInProvider,
  shown: RuntimeClientTarget
): boolean {
  const target = additions.get(provider)?.target
  return (
    target?.kind === 'environment' &&
    shown.kind === 'environment' &&
    target.environmentId === shown.environmentId
  )
}
