import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useGitHubIdentity } from '@/components/settings/accounts/orca/use-github-identity'
import type { GitHubIdentityState } from '@/components/settings/accounts/orca/github-identity-model'

// CREATE-GH-IDENTITY: under the wizard's GitHub access step, once access is settled: the person
// hasn't connected their own GitHub, so commits and PRs from the workspace carry Orca's name.
// Never holds the create. "Not now" is remembered on this device (it's about the person, not the
// repository); Settings › Orca account still has Connect.
const DISMISS_KEY = 'orca.cloud-create.github-identity-not-now.v1'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) !== null
  } catch {
    return false
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    // Storage unavailable: the line just shows again next time.
  }
}

// Disconnect isn't offered here.
const NEVER_CONFIRM = async (): Promise<boolean> => false

export function VmBuildGitHubIdentityLineView({
  state,
  connectedHere,
  onConnect,
  onCancel,
  onNotNow
}: {
  state: GitHubIdentityState
  /** Connected while this sheet was open: say so once instead of vanishing. */
  connectedHere: boolean
  onConnect: () => void
  onCancel: () => void
  onNotNow: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (state.kind === 'connected') {
    return connectedHere ? (
      <p role="status" className="ml-6 text-xs text-muted-foreground">
        {t(
          'orcaCloud.createGitHubIdentity.connected',
          'PRs from this workspace show as @{{login}}.',
          {
            login: state.login
          }
        )}
      </p>
    ) : null
  }
  if (state.kind !== 'disconnected' && state.kind !== 'pending') {
    return null
  }
  const pending = state.kind === 'pending'
  return (
    <div data-vm-build-github-identity={state.kind} className="ml-6 flex flex-col gap-1.5 pb-1">
      <p className="text-xs text-muted-foreground">
        {pending
          ? t(
              'orcaCloud.createGitHubIdentity.waiting',
              'Waiting for GitHub… Finish connecting in your browser.'
            )
          : t('orcaCloud.createGitHubIdentity.ask', 'Connect your GitHub so PRs show as you.')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {pending ? (
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            {t('orcaCloud.createGitHubIdentity.cancel', 'Cancel')}
          </Button>
        ) : (
          <>
            <Button type="button" size="xs" variant="outline" onClick={onConnect}>
              {t('orcaCloud.createGitHubIdentity.connect', 'Connect GitHub')}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onNotNow}>
              {t('orcaCloud.createGitHubIdentity.notNow', 'Not now')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** The live line; reads the person's GitHub connection when the step settles. */
export function VmBuildGitHubIdentityLine(): React.JSX.Element | null {
  const identity = useGitHubIdentity(NEVER_CONFIRM)
  const [dismissed, setDismissed] = React.useState(readDismissed)
  const [seenDisconnected, setSeenDisconnected] = React.useState(false)
  const kind = identity.state.kind
  React.useEffect(() => {
    if (kind === 'disconnected' || kind === 'pending') {
      setSeenDisconnected(true)
    }
  }, [kind])
  if (dismissed && identity.state.kind !== 'pending') {
    return null
  }
  return (
    <VmBuildGitHubIdentityLineView
      state={identity.state}
      connectedHere={seenDisconnected}
      onConnect={() => void identity.connect()}
      onCancel={identity.cancel}
      onNotNow={() => {
        rememberDismissed()
        setDismissed(true)
      }}
    />
  )
}
