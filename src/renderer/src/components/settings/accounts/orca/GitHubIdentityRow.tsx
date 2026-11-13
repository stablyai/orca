import { useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { gitHubUserConnectLinkSource } from '@/lib/orca-cloud/github-link-sources'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import {
  useConfirmationDialog,
  type ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { GitHubIdentityState } from './github-identity-model'
import { useGitHubIdentity } from './use-github-identity'

export function disconnectGitHubConfirmOptions(t: Translate): ConfirmationDialogOptions {
  return {
    title: t('auto.components.settings.orcaAccount.github.disconnectTitle', 'Disconnect GitHub?'),
    description: t(
      'auto.components.settings.orcaAccount.github.disconnectBody',
      "Commits in cloud workspaces will use Orca Cloud's name again."
    ),
    confirmLabel: t('auto.components.settings.orcaAccount.github.disconnectConfirm', 'Disconnect'),
    cancelLabel: t('auto.components.settings.orcaAccount.github.disconnectCancel', 'Cancel'),
    cancelVariant: 'ghost',
    initialFocus: 'cancel'
  }
}

export type GitHubIdentityRowViewProps = {
  state: GitHubIdentityState
  disconnecting?: boolean
  onConnect: () => void
  /** "Copy link" beside Connect: GitHub's OAuth page, minted without opening it. */
  connectLink?: ExternalLinkSource
  onCancel: () => void
  onDisconnect: () => void
  onRetryDisconnect: () => void
}

/** One state of the row; renders nothing until the first status read answers. */
export function GitHubIdentityRowView({
  state,
  disconnecting = false,
  onConnect,
  connectLink,
  onCancel,
  onDisconnect,
  onRetryDisconnect
}: GitHubIdentityRowViewProps): React.JSX.Element | null {
  const t = useTranslate()
  // Connect opens GitHub in the browser; with a link source its chevron copies that page instead.
  const connectButton = (label: string): React.JSX.Element =>
    connectLink ? (
      <OpenExternalSplitButton variant="outline" size="sm" link={connectLink} onClick={onConnect}>
        {label}
      </OpenExternalSplitButton>
    ) : (
      <Button type="button" variant="outline" size="sm" onClick={onConnect}>
        {label}
      </Button>
    )
  if (state.kind === 'unknown') {
    return null
  }
  let detail: React.ReactNode
  let action: React.ReactNode
  if (state.kind === 'pending') {
    detail = (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        {t('auto.components.settings.orcaAccount.github.pending', 'Finish in your browser')}
      </span>
    )
    action = (
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        {t('auto.components.settings.orcaAccount.github.cancel', 'Cancel')}
      </Button>
    )
  } else if (state.kind === 'connected' && state.disconnectFailed) {
    // Both lines: the connection is still there; only the disconnect failed.
    detail = (
      <>
        <span className="block">
          {t('auto.components.settings.orcaAccount.github.connectedAs', 'Connected as @{{login}}', {
            login: state.login
          })}
        </span>
        <span className="block text-destructive">
          {t(
            'auto.components.settings.orcaAccount.github.disconnectError',
            "Couldn't disconnect GitHub."
          )}
        </span>
      </>
    )
    action = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disconnecting}
        onClick={onRetryDisconnect}
      >
        {disconnecting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t('auto.components.settings.orcaAccount.github.tryAgain', 'Try again')}
      </Button>
    )
  } else if (state.kind === 'connected') {
    detail = t(
      'auto.components.settings.orcaAccount.github.connectedAs',
      'Connected as @{{login}}',
      {
        login: state.login
      }
    )
    action = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disconnecting}
        onClick={onDisconnect}
      >
        {disconnecting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t('auto.components.settings.orcaAccount.github.disconnect', 'Disconnect')}
      </Button>
    )
  } else if (state.kind === 'error') {
    detail = t('auto.components.settings.orcaAccount.github.error', "Couldn't connect GitHub.")
    action = connectButton(t('auto.components.settings.orcaAccount.github.tryAgain', 'Try again'))
  } else {
    detail = t(
      'auto.components.settings.orcaAccount.github.description',
      "Connect your GitHub so commits and pushes in cloud workspaces show your name. Until then they use Orca Cloud's."
    )
    action = connectButton(
      t('auto.components.settings.orcaAccount.github.connect', 'Connect GitHub')
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border/60 pt-5">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <GitHubIcon className="size-5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {t('auto.components.settings.orcaAccount.github.title', 'GitHub')}
        </p>
        <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
          {detail}
        </p>
      </div>
      {action}
    </div>
  )
}

const CONNECT_LINK = gitHubUserConnectLinkSource()

/**
 * "GitHub" under the signed-in identity: connect the person's own GitHub for cloud commits.
 * Mount it only while signed in to Orca Cloud.
 */
export function GitHubIdentityRow(): React.JSX.Element | null {
  const t = useTranslate()
  const confirmDialog = useConfirmationDialog()
  const confirm = useCallback(
    () => confirmDialog(disconnectGitHubConfirmOptions(t)),
    [confirmDialog, t]
  )
  const identity = useGitHubIdentity(confirm)
  return (
    <GitHubIdentityRowView
      state={identity.state}
      disconnecting={identity.disconnecting}
      onConnect={() => void identity.connect()}
      connectLink={CONNECT_LINK}
      onCancel={identity.cancel}
      onDisconnect={() => void identity.disconnect()}
      onRetryDisconnect={() => void identity.retryDisconnect()}
    />
  )
}
