import { Check, Copy, ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { Button } from '../ui/button'
import { useCodexPendingLoginUrl } from './use-codex-pending-login-url'

/**
 * The sign-in link of an in-flight `codex login`, so the user can finish the
 * flow in a browser of their choosing instead of only the one Codex opened.
 */
export function CodexLoginLinkNotice(): React.JSX.Element | null {
  const url = useCodexPendingLoginUrl()
  const { copyText, status } = useClipboardTextCopyFeedback(url ?? '')
  if (!url) {
    return null
  }
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AccountsPane.codexLoginLinkPending',
          'Codex opened this sign-in link in your browser. Copy it to finish signing in somewhere else — a private window, or another profile.'
        )}
      </p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground/80">
          {url}
        </span>
        <Button variant="outline" size="xs" onClick={() => void copyText()}>
          {status === 'copied' ? <Check /> : <Copy />}
          {status === 'copied'
            ? translate('auto.components.settings.AccountsPane.codexLoginLinkCopied', 'Copied')
            : translate('auto.components.settings.AccountsPane.codexLoginLinkCopy', 'Copy link')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void window.api.shell.openUrl(url)}>
          <ExternalLink />
          {translate('auto.components.settings.AccountsPane.codexLoginLinkOpen', 'Open')}
        </Button>
      </div>
      {status === 'failed' ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.AccountsPane.codexLoginLinkCopyFailed',
            'Could not copy the link.'
          )}
        </p>
      ) : null}
    </div>
  )
}
