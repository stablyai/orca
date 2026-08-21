import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type QuickOpenInstallRgGuidanceParts = {
  reason: string
  // Why: the fallback runs on whichever host performs the scan. A local scan
  // must not tell the user to install ripgrep "on the remote"; the location
  // phrase in the message is the only signal for which wording to render.
  location: 'local' | 'remote'
  command: string | null
  guidance: string | null
}

const REMOTE_LOCATION_PHRASE = 'on the remote'

/**
 * Parses the install-ripgrep guidance message produced by the relay's
 * buildInstallRgMessage(). Returns the parts needed to render as formatted
 * guidance (reason + install command) when matched, or null otherwise so
 * callers can fall back to plain-text display.
 *
 * Why: the message is plain text on the wire (thrown as an Error), but the
 * renderer is the only place with enough UI vocabulary to present ripgrep
 * as an inline code span and the install command as a copyable code block.
 */
export function parseQuickOpenInstallRgGuidance(
  message: string
): QuickOpenInstallRgGuidanceParts | null {
  const match = message.match(
    /^Quick Open scan too large \((.+?)\)\. Install ripgrep (on the remote|on the host running the Quick Open scan) to enable fast, gitignore-aware listing: (.+)$/
  )
  if (!match) {
    return null
  }
  const reason = match[1]
  const location = match[2] === REMOTE_LOCATION_PHRASE ? 'remote' : 'local'
  const tail = match[3].trim()
  // Why: on unknown distros the relay emits prose like "install ripgrep via
  // your package manager (e.g. apt/dnf/pacman)"; there is no single command
  // to copy, so surface it as plain guidance without the code block.
  const looksLikeCommand = /^(sudo\s+)?(brew|apt|dnf|pacman|apk)\s/.test(tail)
  return {
    reason,
    location,
    command: looksLikeCommand ? tail : null,
    guidance: looksLikeCommand ? null : tail
  }
}

export function QuickOpenInstallRgGuidance({
  reason,
  location,
  command,
  guidance
}: QuickOpenInstallRgGuidanceParts): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this guidance unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(() => {
    if (!command) {
      return
    }
    // Why: use Electron's clipboard IPC instead of navigator.clipboard; the
    // latter often fails silently in the renderer due to focus/permission
    // quirks inside Radix dialogs. All other copy buttons in the app go
    // through window.api.ui.writeClipboardText for consistency.
    void window.api.ui
      .writeClipboardText(command)
      .then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        /* best-effort */
      })
  }, [clearCopiedResetTimer, command])

  return (
    <div className="px-4 py-5 text-sm text-muted-foreground space-y-3">
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-[13px] leading-5">
          {translate('auto.components.QuickOpen.4725b0e931', 'Quick Open scan too large (')}
          {reason}).
        </p>
      </div>
      <p>
        {translate('auto.components.QuickOpen.2ca749c15d', 'Install')}{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
          {translate('auto.components.QuickOpen.5d80dc39bb', 'ripgrep')}
        </code>{' '}
        {location === 'remote'
          ? translate(
              'auto.components.QuickOpen.1cf8561ab4',
              'on the remote to enable fast, gitignore-aware listing:'
            )
          : translate(
              'auto.components.QuickOpen.344f8a48dd',
              'on the host running the Quick Open scan to enable fast, gitignore-aware listing:'
            )}
      </p>
      {command ? (
        <div className="flex items-center gap-2 rounded border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
          <span className="flex-1 truncate">{command}</span>
          <button
            ref={setCopyButtonRef}
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={translate('auto.components.QuickOpen.73b44e7bde', 'Copy install command')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied
              ? translate('auto.components.QuickOpen.cf144856dc', 'Copied')
              : translate('auto.components.QuickOpen.995be8ea22', 'Copy')}
          </button>
        </div>
      ) : guidance ? (
        <p className="text-[13px] leading-5 text-foreground">{guidance}</p>
      ) : null}
    </div>
  )
}
