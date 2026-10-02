import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCodexSharedServerWarningEnabled } from '../../../../shared/codex-terminal-server-isolation'
import { CodexSharedServerFixDialog } from './CodexSharedServerFixDialog'
import { retireCodexTerminalServerIsolationNotice } from './codex-terminal-server-isolation-notice'

// Why a ladder: Codex joins or starts the server a few seconds after its process appears.
const CHECK_DELAYS_MS = [1_000, 4_000, 10_000] as const
// Why module scope: a pane remounts on tab switches, and × must hold for the app session.
const dismissedPtyIds = new Set<string>()

/** Asks on the ladder until an answer is yes; returns a cancel that drops any later answer. */
function askUntilOnSharedServer(
  ask: (ptyId: string) => Promise<boolean>,
  ptyId: string,
  onJoined: () => void
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (attempt: number): void => {
    timer = setTimeout(() => {
      void ask(ptyId)
        .catch(() => false)
        .then((joined) => {
          if (cancelled) {
            return
          }
          if (joined) {
            onJoined()
          } else if (attempt + 1 < CHECK_DELAYS_MS.length) {
            schedule(attempt + 1)
          }
        })
    }, CHECK_DELAYS_MS[attempt])
  }
  schedule(0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

function usePaneCodexOnSharedServer(ptyId: string, enabled: boolean, recheck: number): boolean {
  const [joined, setJoined] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const cancel = askUntilOnSharedServer(window.api.pty.isCodexOnSharedServer, ptyId, () =>
      setJoined(true)
    )
    return () => {
      cancel()
      setJoined(false)
    }
  }, [enabled, ptyId, recheck])
  return joined
}

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const reserve = (): void => {
      pane.style.setProperty('--orca-pane-top-banner-height', `${banner.offsetHeight}px`)
    }
    reserve()
    const observer = new ResizeObserver(reserve)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--orca-pane-top-banner-height')
    }
  }, [])
  return ref
}

export function CodexSharedServerBanner({
  ptyId,
  paneKey
}: {
  ptyId: string
  paneKey: string
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => dismissedPtyIds.has(ptyId))
  const warningEnabled = useAppStore(
    (state) => state.settings !== null && isCodexSharedServerWarningEnabled(state.settings)
  )
  // Why either signal: a typed codex is seen by the process read, or by its hooks when that read has no command marks.
  const codexInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'codex' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'codex'
  )
  // Why a recheck: after the fix stops the server, the banner hides unless a new one is joined.
  const [recheck, setRecheck] = useState(0)
  const joined = usePaneCodexOnSharedServer(
    ptyId,
    warningEnabled && codexInPane && !dismissed,
    recheck
  )
  const [fixOpen, setFixOpen] = useState(false)
  // Why fixOpen keeps it: stopping the server ends this pane's Codex, which must not close the dialog.
  if (!joined && !fixOpen) {
    return null
  }
  return (
    <CodexSharedServerBannerContent
      ptyId={ptyId}
      fixOpen={fixOpen}
      onFixOpenChange={setFixOpen}
      onServerStopped={() => setRecheck((count) => count + 1)}
      onDismiss={() => {
        dismissedPtyIds.add(ptyId)
        setDismissed(true)
      }}
      onDontShowAgain={() =>
        void useAppStore.getState().updateSettings({ codexSharedServerWarning: false })
      }
    />
  )
}

function CodexSharedServerBannerContent({
  ptyId,
  fixOpen,
  onFixOpenChange,
  onServerStopped,
  onDismiss,
  onDontShowAgain
}: {
  ptyId: string
  fixOpen: boolean
  onFixOpenChange: (open: boolean) => void
  onServerStopped: () => void
  onDismiss: () => void
  onDontShowAgain: () => void
}): React.JSX.Element {
  const ref = useReservePaneTopSpace()
  useEffect(retireCodexTerminalServerIsolationNotice, [])

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-16: the pane's own split/close controls float over its top-right corner.
      className="pane-top-banner @container border-b border-status-warning-border bg-status-warning-background py-2 pr-16 pl-3 text-xs"
    >
      {/* Why a container query: split panes are narrow, so actions drop below the text there.
          Narrow and wide variants never share a property, so an unlayered utility cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">
              {translate(
                'terminal.codexSharedServerBanner.title',
                'This Codex is sharing a server with your other Codex tabs'
              )}
            </p>
            <p className="text-muted-foreground">
              {translate(
                'terminal.codexSharedServerBanner.body',
                'Sessions may end unexpectedly, and agent status may be wrong.'
              )}{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                onClick={() => onFixOpenChange(true)}
              >
                {translate('terminal.codexSharedServerBanner.learnMore', 'Learn more')}
              </button>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5 @max-[44rem]:pl-6.5">
          <Button type="button" variant="outline" size="xs" onClick={() => onFixOpenChange(true)}>
            {translate('terminal.codexSharedServerBanner.fix', 'Fix')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
            {translate('terminal.codexSharedServerBanner.dontShowAgain', "Don't show again")}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            {translate('terminal.codexSharedServerBanner.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
      <CodexSharedServerFixDialog
        ptyId={ptyId}
        open={fixOpen}
        onOpenChange={onFixOpenChange}
        onServerStopped={onServerStopped}
      />
    </div>
  )
}
