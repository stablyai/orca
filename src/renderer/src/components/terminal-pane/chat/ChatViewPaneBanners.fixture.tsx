// A terminal pane in chat view with one of its pane-top banners. "before": the banner portals into
// the pane, under the chat cover (z-10), so it is hidden. "after": PaneBannerPortal puts it at the top
// of the chat column. The banners render through the shared PaneTopWarningBanner with their catalog
// copy; their own state hooks (daemon holds, worker lifetimes, provider checks) are not seeded here.
import React, { useMemo } from 'react'
import { Timer } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { PaneTopWarningBanner } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { workerKeepOpenLabel } from '@/runtime/agent-orchestration/worker-auto-close'
import { ChatBannerSlot } from './ChatBannerSlot'
import { PaneBannerPortal } from './PaneBannerPortal'

type BannerKind = 'newerDaemon' | 'claudeOldTerminal' | 'codexSharedServer' | 'workerAutoClose'

function Banner({ kind }: { kind: BannerKind }): React.JSX.Element {
  switch (kind) {
    case 'newerDaemon':
      return (
        <PaneTopWarningBanner
          title={t(
            'terminal.newerDaemonBanner.title',
            'This terminal was opened in a newer version of Orca'
          )}
          body={t(
            'terminal.newerDaemonBanner.resumableBody',
            'Reopen it here to keep working. Your agent session will resume.'
          )}
          primaryAction={
            <Button type="button" variant="outline" size="xs">
              {t('terminal.newerDaemonBanner.reopenTerminal', 'Reopen {{count}} terminals', {
                count: 1,
                defaultValue_one: 'Reopen terminal'
              })}
            </Button>
          }
        />
      )
    case 'claudeOldTerminal':
      return (
        <PaneTopWarningBanner
          title={t(
            'terminal.claudeOldTerminalBanner.title',
            "This terminal was opened before Orca's Claude account update, so claude here uses System default's login."
          )}
          primaryAction={
            <Button type="button" variant="outline" size="xs">
              {t('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
            </Button>
          }
        />
      )
    case 'codexSharedServer':
      return (
        <PaneTopWarningBanner
          title={t(
            'terminal.codexSharedServerBanner.title',
            'This Codex is sharing a server with your other Codex tabs'
          )}
          primaryAction={
            <Button type="button" variant="outline" size="xs">
              {t('terminal.codexSharedServerBanner.fix', 'Fix')}
            </Button>
          }
          onDismiss={() => undefined}
        />
      )
    case 'workerAutoClose':
      return (
        <PaneTopWarningBanner
          tone="accent"
          icon={Timer}
          badge={t('components.orchestration.workerAutoClose.temporaryBadge', 'Temporary')}
          title={t(
            'components.orchestration.workerAutoClose.bannerRunning',
            'Orchestration worker · Closes 2 minutes after it finishes'
          )}
          primaryAction={
            <Button type="button" variant="default" size="xs">
              {workerKeepOpenLabel(t)}
            </Button>
          }
        />
      )
  }
}

function ChatViewPane({
  kind,
  fixed,
  width
}: {
  kind: BannerKind
  fixed: boolean
  width: number
}): React.JSX.Element {
  const paneKey = `fixture-chat-view-${kind}-${fixed ? 'after' : 'before'}`
  const container = useMemo(() => document.createElement('div'), [])
  const [pane, setPane] = React.useState<HTMLDivElement | null>(null)
  return (
    <div className="bg-background p-4">
      <div
        ref={setPane}
        className="pane relative h-[320px] overflow-hidden rounded-md border border-border bg-background"
        style={{ width }}
      >
        <div className="xterm-container p-2 font-mono text-xs text-muted-foreground">~/repo $</div>
        {/* Stands in for NativeChatPaneCover: the same classes, over the whole pane. */}
        <div className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-chat-canvas">
          {fixed ? <ChatBannerSlot paneKey={paneKey} /> : null}
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3 text-sm">
            <div className="self-end rounded-lg bg-muted px-3 py-2">Fix the flaky auth test</div>
            <div className="text-foreground">
              The assertion in <code>session.test.ts</code> races the token refresh.
            </div>
          </div>
          <div className="m-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            Ask anything, @ to mention files, / for commands
          </div>
        </div>
        {pane ? (
          <PaneBannerPortal
            pane={{ container: fixed ? container : pane }}
            paneKey={paneKey}
            portalKey="fixture"
          >
            <Banner kind={kind} />
          </PaneBannerPortal>
        ) : null}
      </div>
    </div>
  )
}

const fixture = (kind: BannerKind, fixed: boolean, width = 760) =>
  defineFixture({
    width: width + 40,
    render: () => <ChatViewPane kind={kind} fixed={fixed} width={width} />
  })

export const newerDaemonBefore = fixture('newerDaemon', false)
export const newerDaemonAfter = fixture('newerDaemon', true)
export const claudeOldTerminalBefore = fixture('claudeOldTerminal', false)
export const claudeOldTerminalAfter = fixture('claudeOldTerminal', true)
export const codexSharedServerBefore = fixture('codexSharedServer', false)
export const codexSharedServerAfter = fixture('codexSharedServer', true)
export const workerAutoCloseBefore = fixture('workerAutoClose', false)
export const workerAutoCloseAfter = fixture('workerAutoClose', true)
export const workerAutoCloseAfterNarrow = fixture('workerAutoClose', true, 420)
