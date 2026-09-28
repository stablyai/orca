import { AlertCircle, RefreshCw, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useWorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import { useUserDisconnectedHostConnect } from '@/ssh/use-user-disconnected-host-connect'
import {
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_OWNER_NOT_READY_ERROR
} from './editor-panel-content-types'
import { isReloadedWhenHostConnects } from './useEditorPanelFileLoadRetry'

// Why: `loadError` is stored as English so logs and non-view consumers stay readable; the
// user-facing copy is keyed by the machine sentinel, never by the text, so localization
// cannot break the terminal-state comparison upstream (#21041).
function localizeFileLoadError(message: string, code: string | undefined): string {
  if (code === WORKTREE_HOST_UNRESOLVED_CODE) {
    return translate(
      'editor.fileLoad.hostUnresolved',
      "The host couldn't find this file's workspace. It may have been removed, or the host may not know about it yet. Retry, or close this tab from the tab strip."
    )
  }
  return message
}

// Why no Close action here: this view renders for real tabs and for synthesized inline
// conflict rows alike, and only the tab strip's own close path carries the pin, shared-
// reference, and unsaved-changes semantics. The copy points the user at that path instead
// of adding a second one that would have to reimplement it (#21041).
export function EditorFileLoadErrorView({
  message,
  code,
  worktreeId = null,
  reloadsWhenHostConnects = false,
  onRetry
}: {
  message: string
  code?: string
  /** The file's workspace; lets the view say when the user's Disconnect holds its host down. */
  worktreeId?: string | null
  /** The panel's retry gate reloads this file when its host connects; only its active file. */
  reloadsWhenHostConnects?: boolean
  onRetry: () => void
}): React.JSX.Element {
  const host = useWorktreeHostConnection(worktreeId)
  const userDisconnectedHost = useUserDisconnectedHostConnect(host)
  // Why: while the host connects, a failure its connection caused is replaced by that connection
  // and reloads once it lands, so show the connecting state rather than the stale raw error.
  const shownMessage =
    reloadsWhenHostConnects &&
    host.phase === 'connecting' &&
    isReloadedWhenHostConnects({ loadError: message, loadErrorCode: code })
      ? WORKTREE_OWNER_NOT_READY_ERROR
      : localizeFileLoadError(message, code)
  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4">
        {/* Why neutral: the user's own Disconnect is not a failure, so it reads like the other
            pane cards for that host rather than as an error. */}
        {userDisconnectedHost ? (
          <ServerOff className="mt-0.5 size-4 flex-shrink-0" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
        )}
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {userDisconnectedHost
              ? translate('editor.fileLoad.userDisconnectedTitle', 'You disconnected {{host}}', {
                  host: userDisconnectedHost.hostLabel
                })
              : translate('auto.components.editor.EditorContent.39f018b052', 'Unable to load file')}
          </div>
          {userDisconnectedHost ? (
            // Why Connect replaces Retry: a read cannot succeed until the user connects the host,
            // and the file reloads on its own once it does.
            <>
              <div className="mt-1 break-words">
                {translate(
                  'editor.fileLoad.userDisconnectedDescription',
                  'Connect it to load this file.'
                )}
              </div>
              <Button
                type="button"
                size="sm"
                className="mt-3"
                disabled={userDisconnectedHost.connecting}
                onClick={userDisconnectedHost.connect}
              >
                {translate('editor.fileLoad.connect', 'Connect')}
              </Button>
            </>
          ) : (
            <>
              <div className="mt-1 break-words">{shownMessage}</div>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
                <RefreshCw className="size-3.5" />
                {translate('auto.components.editor.EditorContent.2a512bb46a', 'Retry')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
