import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'

// ERR_SOCKS_CONNECTION_FAILED, ERR_SOCKS_CONNECTION_HOST_UNREACHABLE, ERR_PROXY_CONNECTION_FAILED: what a
// desktop-hosted cloud page gets when the sandbox (its SOCKS route) cannot connect.
const SANDBOX_ROUTE_FAILURE_CODES = new Set([-120, -121, -130])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type SandboxUnreachableSite = {
  kind: 'outside' | 'sandbox-server'
  host: string
  url: string
}

/**
 * An Orca Cloud page that failed because the sandbox could not connect: an outside host not on the
 * sandbox's approved list, or a sandbox server (localhost) that is not running.
 */
export function describeSandboxUnreachableSite(
  loadError: Pick<BrowserLoadError, 'code' | 'validatedUrl'>,
  fallbackUrl: string
): SandboxUnreachableSite | null {
  if (!SANDBOX_ROUTE_FAILURE_CODES.has(loadError.code)) {
    return null
  }
  const url = loadError.validatedUrl || fallbackUrl
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return {
      kind: LOOPBACK_HOSTS.has(parsed.hostname) ? 'sandbox-server' : 'outside',
      host: parsed.host,
      url
    }
  } catch {
    return null
  }
}

/**
 * How long to wait before the next re-try of a sandbox server that isn't running yet: every 4 s for
 * 2 minutes, then every 15 s, then stop at 10 minutes (re-armed when the user returns to the tab).
 */
export function sandboxServerRetryDelayMs(elapsedMs: number): number | null {
  if (elapsedMs < 2 * 60_000) {
    return 4_000
  }
  if (elapsedMs < 10 * 60_000) {
    return 15_000
  }
  return null
}

/** Re-tries while enabled; each enable (tab shown again, sandbox awake again) restarts the schedule. */
function useSandboxServerRetry(enabled: boolean, onRetry: () => void): void {
  const retryRef = useRef(onRetry)
  retryRef.current = onRetry
  useEffect(() => {
    if (!enabled) {
      return
    }
    const startedAt = Date.now()
    let timer: number | undefined
    const schedule = (): void => {
      const delay = sandboxServerRetryDelayMs(Date.now() - startedAt)
      if (delay === null) {
        return
      }
      timer = window.setTimeout(() => {
        // The reload swaps the page in place when the server answers; no toast.
        retryRef.current()
        schedule()
      }, delay)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [enabled])
}

export function SandboxUnreachableSiteState({
  site,
  errorName,
  onOpenInBrowser,
  onRetry,
  isActive,
  sandboxAwake
}: {
  site: SandboxUnreachableSite
  /** Raw Chromium error name, kept out of the main text for debugging. */
  errorName: string | null
  onOpenInBrowser: (url: string) => void
  /** Re-attempts the load; a sandbox server that starts later then appears on its own. */
  onRetry: () => void
  isActive: boolean
  /** False while the sandbox is asleep, waking or going to sleep: a re-try must never wake it. */
  sandboxAwake: boolean
}): React.JSX.Element {
  const t = useTranslate()
  useSandboxServerRetry(site.kind === 'sandbox-server' && isActive && sandboxAwake, onRetry)
  return (
    <div
      data-testid="sandbox-unreachable-site"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center"
    >
      <Globe className="size-5 text-muted-foreground" aria-hidden />
      <div className="text-sm font-medium text-foreground">
        {t(
          'auto.components.browser.pane.SandboxUnreachableSite.title',
          "The sandbox can't reach {{value0}}",
          {
            value0: site.host
          }
        )}
      </div>
      <div className="max-w-sm text-xs leading-5 text-muted-foreground">
        {site.kind === 'sandbox-server'
          ? t(
              'auto.components.browser.pane.SandboxUnreachableSite.notRunning',
              'Nothing is running on {{value0}} in the sandbox.',
              { value0: site.host }
            )
          : t(
              'auto.components.browser.pane.SandboxUnreachableSite.outside',
              'Orca Cloud sandboxes only reach approved sites and servers running in the sandbox, like localhost:3000.'
            )}
      </div>
      {site.kind === 'outside' ? (
        <Button size="sm" onClick={() => onOpenInBrowser(site.url)}>
          {t(
            'auto.components.browser.pane.SandboxUnreachableSite.openInBrowser',
            'Open in your browser'
          )}
        </Button>
      ) : null}
      {errorName ? (
        <div className="font-mono text-[11px] text-muted-foreground/70">{errorName}</div>
      ) : null}
    </div>
  )
}
