import { Copy, ExternalLink, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openOfficeInstallTerminal } from '@/lib/office-install-terminal'
import {
  OFFICECLI_RELEASES_URL,
  officeInstallCommandForPlatform,
  type OfficeHostPlatform
} from '../../../../../shared/office-preview-contracts'
import { officeFailureDetail, officeFailureTitle } from './office-preview-status'

/**
 * What a reader sees when the owning host has no `officecli`.
 *
 * Detect, explain, do not install — the stance `src/shared/quick-open-install-rg.ts` already sets
 * for a missing third-party binary. Three things this panel is careful about:
 *
 *  - it names the host, because on a remote workspace the reader's own machine is the wrong place
 *    to look;
 *  - the command is selectable text the reader can read before running, not a button that runs it;
 *  - **Run in terminal** opens a terminal on that host with the command typed and waiting. The
 *    reader presses Enter. See `office-install-terminal.ts` for why that boundary matters.
 */
export function OfficeMissingBinaryNotice({
  worktreeId,
  hostLabel,
  platform,
  onRetry,
  retrying
}: {
  worktreeId: string
  hostLabel: string | null
  platform: OfficeHostPlatform
  onRetry: () => void
  retrying: boolean
}): React.JSX.Element {
  const command = officeInstallCommandForPlatform(platform)

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <TerminalSquare className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{officeFailureTitle('OFFICECLI_NOT_FOUND')}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {officeFailureDetail('OFFICECLI_NOT_FOUND', hostLabel)}
      </p>
      {command ? (
        <div className="flex w-full max-w-md items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
          <code className="min-w-0 flex-1 select-text truncate text-left font-mono text-xs">
            {command}
          </code>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={translate('auto.components.office.preview.copyInstallCommand', 'Copy')}
            onClick={() => void window.api.ui.writeClipboardText(command)}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {command ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openOfficeInstallTerminal(worktreeId, command)}
          >
            {translate('auto.components.office.preview.runInTerminal', 'Run in terminal')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying
            ? translate('auto.components.office.preview.retrying', 'Checking…')
            : translate('auto.components.office.preview.retry', 'Retry')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void window.api.shell.openUrl(OFFICECLI_RELEASES_URL)}
        >
          <ExternalLink className="size-3.5" />
          {translate('auto.components.office.preview.releases', 'Releases')}
        </Button>
      </div>
      {command ? (
        <p className="max-w-md text-[11px] text-muted-foreground">
          {translate(
            'auto.components.office.preview.runInTerminalHint',
            'Orca types the command for you and stops there — you press Enter.'
          )}
        </p>
      ) : null}
    </div>
  )
}
