import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  ReopenBrowserPageOnServerButton,
  reopenOnServerCaveat
} from './ReopenBrowserPageOnServerButton'

/**
 * What a client-hosted page shows when its guest is not here: the page belongs to another desktop,
 * or the host that owned it is gone. There is nothing to retry locally, so the only way forward
 * offered is reopening the page on the server.
 */
export function ClientHostedBrowserUnavailableNotice({
  runtimeEnvironmentId,
  worktreeId,
  lastCommittedUrl
}: {
  runtimeEnvironmentId: string
  worktreeId: string
  lastCommittedUrl: string
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {translate('browser.clientHosted.unavailableTitle', 'Client-hosted browser unavailable')}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          {translate(
            'browser.clientHosted.unavailableDescription',
            'This page is attached to a different desktop or is no longer available.'
          )}
        </div>
        <div className="text-xs leading-5 text-muted-foreground">{reopenOnServerCaveat()}</div>
        <ReopenBrowserPageOnServerButton
          environmentId={runtimeEnvironmentId}
          worktreeId={worktreeId}
          lastCommittedUrl={lastCommittedUrl}
        />
      </div>
    </div>
  )
}
