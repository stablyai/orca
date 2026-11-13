// CHAT-BANNERS (PR-A): each cloud banner in a terminal tab's chat view, in the chat column under the
// pane's title row and above the transcript, through the real slot and portal. The composer shows the
// disabled hint while a held launch blocks sending.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { CloudAgentRestartAttempt } from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import type { CloudRunningStrip } from '@/lib/orca-cloud/cloud-running-agent-signout'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { CloudWokeProcessesNotice } from '../orca-cloud/offline/CloudWokeProcessesNotice'
import {
  CloudAgentSignInStrip,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { cloudAgentStripModel } from './cloud-agent-strip-model'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import {
  cloudRestartAttemptModel,
  cloudRestartFreshModel,
  cloudRunningStripModel
} from './cloud-running-strip-model'
import { CloudChatBannerSlot } from './CloudChatBannerSlot'
import { CloudPaneBannerPortal } from './CloudPaneBannerPortal'
import { cloudChatHoldHint } from './use-cloud-chat-hold-hint'

const noop = (): void => {}
const ACTIONS: CloudStripActions = {
  primary: noop,
  submitCode: noop,
  pasteCode: noop,
  useCode: noop,
  useApiKey: noop,
  cancel: noop
}
const PROMPT = 'Fix the flaky auth test and open a PR'

type Banner =
  | { kind: 'setUp'; setup: OrcaCloudAgentSetup }
  | { kind: 'expired' }
  | { kind: 'running'; running: CloudRunningStrip }
  | { kind: 'restart'; attempt: CloudAgentRestartAttempt }
  | { kind: 'fresh' }
  | { kind: 'woke' }

function BannerContent({ banner, width }: { banner: Banner; width: number }): React.JSX.Element {
  if (banner.kind === 'woke') {
    return (
      <CloudWokeProcessesNotice
        action={{ kind: 'restart', agent: 'Claude' }}
        onAction={noop}
        onDismiss={noop}
      />
    )
  }
  const model =
    banner.kind === 'setUp'
      ? cloudAgentSetupStripModel({
          agent: 'claude',
          setup: banner.setup,
          ready: false,
          t: translate
        })
      : banner.kind === 'expired'
        ? cloudAgentStripModel({
            agent: 'claude',
            reason: 'accountExpired',
            view: null,
            hostLabel: translate('agentSignInStrip.sandbox', 'the sandbox'),
            t: translate
          })
        : banner.kind === 'running'
          ? cloudRunningStripModel(banner.running, translate)
          : banner.kind === 'restart'
            ? cloudRestartAttemptModel(banner.attempt, translate)
            : cloudRestartFreshModel('claude', translate)
  const held = banner.kind === 'setUp' || banner.kind === 'expired'
  return (
    <CloudAgentSignInStrip
      model={model}
      prompt={held ? PROMPT : null}
      width={cloudStripWidth(width)}
      actions={ACTIONS}
    />
  )
}

function ChatColumn({
  banner,
  width,
  structured = false
}: {
  banner: Banner
  width: number
  /** PR-B: a structured chat renders its strip in place (CloudStructuredChatBanners), no portal. */
  structured?: boolean
}): React.JSX.Element {
  const paneKey = `fixture-chat-${banner.kind}-${width}`
  const container = React.useMemo(() => document.createElement('div'), [])
  const pane: Pick<ManagedPane, 'container'> = { container }
  const hint =
    banner.kind === 'setUp'
      ? cloudChatHoldHint({ agent: 'claude', reason: 'notSetUp' }, null, translate)
      : banner.kind === 'expired'
        ? cloudChatHoldHint({ agent: 'claude', reason: 'accountExpired' }, null, translate)
        : undefined
  return (
    <div className="bg-background p-4">
      {/* Stands in for the chat cover over a terminal pane: its title row floats over the top. */}
      <div
        className="pane relative flex h-[360px] flex-col overflow-hidden rounded-md border border-border bg-chat-canvas"
        style={{ width }}
      >
        <div className="pane-title-overlay-layer">
          <div className="pane-title-bar" data-chromeless>
            <div className="pane-title-actions ml-auto flex shrink-0 items-center gap-0">
              <button type="button" className="pane-title-split-trigger" aria-label="Split pane">
                ⊟
              </button>
              <button type="button" className="pane-title-close" aria-label="Close pane">
                ×
              </button>
            </div>
          </div>
        </div>
        {structured ? (
          <div data-cloud-chat-banners="" className="shrink-0">
            <BannerContent banner={banner} width={width} />
          </div>
        ) : (
          <>
            <CloudChatBannerSlot paneKey={paneKey} />
            <CloudPaneBannerPortal pane={pane} paneKey={paneKey} portalKey="fixture" stripLayer>
              <BannerContent banner={banner} width={width} />
            </CloudPaneBannerPortal>
          </>
        )}
        {/* The transcript starts below the banner. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3 text-sm">
          {held(banner) ? null : (
            <>
              <div className="self-end rounded-lg bg-muted px-3 py-2">{PROMPT}</div>
              <div className="text-foreground">
                I found the flaky assertion in <code>session.test.ts</code>; it races the token
                refresh.
              </div>
            </>
          )}
        </div>
        {/* The composer: disabled, its placeholder pointing at the banner, while a launch is held. */}
        <div className="m-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {hint ??
              translate(
                'components.native-chat.composer.placeholder',
                'Ask anything, @ to mention files, / for commands'
              )}
          </span>
        </div>
      </div>
    </div>
  )
}

function held(banner: Banner): boolean {
  return banner.kind === 'setUp' || banner.kind === 'expired'
}

const fixture = (banner: Banner, width = 760, structured = false) =>
  defineFixture({
    width: width + 40,
    render: () => <ChatColumn banner={banner} width={width} structured={structured} />
  })
const NARROW = 420

export const notSetUp = fixture({ kind: 'setUp', setup: { phase: 'idle' } })
export const notSetUpNarrow = fixture({ kind: 'setUp', setup: { phase: 'idle' } }, NARROW)
const browserCode: OrcaCloudAgentSetup = {
  phase: 'browser',
  startedAt: 0,
  canReopen: true,
  acceptsCode: true
}
export const setupPasteCode = fixture({ kind: 'setUp', setup: browserCode })
export const setupPasteCodeNarrow = fixture({ kind: 'setUp', setup: browserCode }, NARROW)
export const setupCodeRejected = fixture({
  kind: 'setUp',
  setup: { ...browserCode, code: 'rejected' }
})
export const setupCodeRejectedNarrow = fixture(
  { kind: 'setUp', setup: { ...browserCode, code: 'rejected' } },
  NARROW
)
/** After a refusal, before the fresh link: field and "Open again" stay, disabled. */
export const setupCodeGap = fixture({
  kind: 'setUp',
  setup: { phase: 'browser', startedAt: 0, canReopen: false, code: 'rejected' }
})
export const expired = fixture({ kind: 'expired' })
export const expiredNarrow = fixture({ kind: 'expired' }, NARROW)
export const runningExpired = fixture({
  kind: 'running',
  running: { phase: 'expired', agent: 'claude' }
})
export const runningExpiredNarrow = fixture(
  { kind: 'running', running: { phase: 'expired', agent: 'claude' } },
  NARROW
)
export const runningRenewed = fixture({
  kind: 'running',
  running: { phase: 'renewed', agent: 'claude', resumable: true }
})
export const restarting = fixture({
  kind: 'restart',
  attempt: { phase: 'restarting', agent: 'claude', resumable: true, ptyId: 'p', launchedAt: null }
})
export const restartFailed = fixture({
  kind: 'restart',
  attempt: {
    phase: 'failed',
    agent: 'claude',
    resumable: true,
    ptyId: 'p',
    launchedAt: null,
    failure: 'hostUnresponsive'
  }
})
export const startedFresh = fixture({ kind: 'fresh' })
/** RA-WAKE in the chat: Restart Claude only (no Rerun). */
export const wokeRestart = fixture({ kind: 'woke' })
export const wokeRestartNarrow = fixture({ kind: 'woke' }, NARROW)

/** PR-B: a structured agent-session chat on Orca Cloud, held before its session is created. */
export const structuredNotSetUp = fixture({ kind: 'setUp', setup: { phase: 'idle' } }, 760, true)
export const structuredNotSetUpNarrow = fixture(
  { kind: 'setUp', setup: { phase: 'idle' } },
  NARROW,
  true
)
export const structuredPasteCode = fixture({ kind: 'setUp', setup: browserCode }, 760, true)
export const structuredPasteCodeNarrow = fixture(
  { kind: 'setUp', setup: browserCode },
  NARROW,
  true
)
export const structuredCodeRejected = fixture(
  { kind: 'setUp', setup: { ...browserCode, code: 'rejected' } },
  760,
  true
)
export const structuredExpired = fixture({ kind: 'expired' }, 760, true)
export const structuredExpiredNarrow = fixture({ kind: 'expired' }, NARROW, true)
