import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { AgentSignInGateView } from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import type { CloudAgentStripReason } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import {
  CloudAgentSignInStrip,
  CloudStripLayer,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { cloudAgentStripModel } from './cloud-agent-strip-model'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { cloudRestartAttemptModel, cloudRunningStripModel } from './cloud-running-strip-model'
import type { CloudAgentRestartAttempt } from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import type { CloudRunningStrip } from '@/lib/orca-cloud/cloud-running-agent-signout'

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

function Pane({
  reason = 'accountExpired',
  view = null,
  agent = 'claude',
  width = 900,
  running,
  restart,
  setUp
}: {
  reason?: CloudAgentStripReason
  view?: AgentSignInGateView | null
  agent?: HostAgentSignInAgent
  width?: number
  /** RA-11: the strip over a running agent instead of a held launch. */
  running?: CloudRunningStrip
  /** RA-11: a Restart in flight, or one that failed. */
  restart?: CloudAgentRestartAttempt
  /** PC-3b: a launch held because the agent isn't set up for Orca Cloud yet. */
  setUp?: { setup: OrcaCloudAgentSetup; ready?: boolean }
}): React.JSX.Element {
  const model = setUp
    ? cloudAgentSetupStripModel({
        agent,
        setup: setUp.setup,
        ready: setUp.ready ?? false,
        t: translate
      })
    : restart
      ? cloudRestartAttemptModel(restart, translate)
      : running
        ? cloudRunningStripModel(running, translate)
        : cloudAgentStripModel({
            agent,
            reason,
            view,
            hostLabel: translate('agentSignInStrip.sandbox', 'the sandbox'),
            t: translate
          })
  return (
    <div className="bg-background p-4">
      {/* Stands in for a terminal pane: its title row (split, close) stays above the strip. */}
      <div
        data-strip-pane
        className="pane relative h-[220px] overflow-hidden rounded-md border border-border bg-background"
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
        <CloudStripLayer>
          <CloudAgentSignInStrip
            model={model}
            prompt={running ? null : PROMPT}
            width={cloudStripWidth(width)}
            actions={ACTIONS}
          />
        </CloudStripLayer>
        {/* The terminal: it starts below the strip (reserved, never covered) and keeps its rows. */}
        <div className="xterm-container overflow-hidden font-mono text-xs leading-4 text-muted-foreground">
          {running ? (
            <>
              <div>⏺ Reading src/auth/session.ts…</div>
              <div>⏺ API Error: 401 · Not logged in · Run /login</div>
            </>
          ) : null}
          <div data-terminal-last-row>~/acme/web $</div>
        </div>
      </div>
    </div>
  )
}

const fixture = (props: React.ComponentProps<typeof Pane>) =>
  defineFixture({ width: (props.width ?? 900) + 40, render: () => <Pane {...props} /> })

/** S4-c, card 13 in its strip form: account-level recovery with Renew (to S0). */
export const needExpired = fixture({ reason: 'accountExpired' })
export const needExpiredCodex = fixture({ reason: 'accountExpired', agent: 'codex' })
export const killSwitch = fixture({ reason: 'paused', view: { step: 'need' } })
export const notOffered = fixture({ reason: 'notOffered', view: { step: 'need' } })
export const waiting = fixture({
  reason: 'paused',
  view: { step: 'waiting', url: 'https://claude.ai/oauth' }
})
export const code = fixture({
  reason: 'paused',
  agent: 'codex',
  view: { step: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'K7QX-M2PL' }
})
export const codePaste = fixture({
  reason: 'paused',
  view: { step: 'paste', url: 'https://claude.ai/oauth', submitting: false, refusal: null }
})
export const wrongAccount = fixture({
  reason: 'paused',
  view: { step: 'signed', email: 'nw@personal.dev', expectedEmail: 'nw@stably.ai' }
})
export const error = fixture({
  reason: 'paused',
  view: { step: 'error', kind: 'timeout', message: '' }
})
export const errorOffline = fixture({
  reason: 'paused',
  view: { step: 'error', kind: 'offline', message: '' }
})
export const portBusy = fixture({
  reason: 'paused',
  view: { step: 'error', kind: 'port_busy', message: '', port: 54545 }
})
export const done = fixture({
  reason: 'paused',
  view: { step: 'signed', email: 'nw@stably.ai' }
})
export const needNarrow = fixture({ reason: 'paused', view: { step: 'need' }, width: 640 })
export const needTiny = fixture({ reason: 'paused', view: { step: 'need' }, width: 520 })
export const waitingNarrow = fixture({
  reason: 'paused',
  view: { step: 'waiting', url: 'https://claude.ai/oauth' },
  width: 640
})
export const needExpiredNarrow = fixture({ reason: 'accountExpired', width: 520 })
/** Below 360 px: one line and Renew; the detail stays the region's description. */
export const needExpiredCompact = fixture({ reason: 'accountExpired', width: 320 })

/** RA-11 state 1: Claude was running when its Orca-account sign-in expired. */
export const runningExpired = fixture({ running: { phase: 'expired', agent: 'claude' } })
export const runningExpiredCompact = fixture({
  running: { phase: 'expired', agent: 'claude' },
  width: 320
})
/** RA-11 state 2: renewed; this pane's agent still needs a restart (resumes its conversation). */
export const runningRenewed = fixture({
  running: { phase: 'renewed', agent: 'claude', resumable: true }
})
/** RA-11 state 2 when the session can't be resumed. */
export const runningRenewedFresh = fixture({
  running: { phase: 'renewed', agent: 'claude', resumable: false }
})
export const runningRenewedNarrow = fixture({
  running: { phase: 'renewed', agent: 'claude', resumable: true },
  width: 520
})
/** RA-11 after Restart: the strip stays, spinner, button disabled, until the agent reports. */
export const runningRestarting = fixture({
  restart: { phase: 'restarting', agent: 'claude', resumable: true, ptyId: 'p', launchedAt: null }
})
/** RA-11: nothing relaunched in time. */
export const runningRestartFailed = fixture({
  restart: {
    phase: 'failed',
    agent: 'claude',
    resumable: true,
    ptyId: 'p',
    launchedAt: null,
    failure: 'hostUnresponsive'
  }
})

/** PC-3b: the launch holds; Set up once runs the one-time Orca Cloud setup in the pane. */
export const notSetUp = fixture({ setUp: { setup: { phase: 'idle' } } })
export const notSetUpCompact = fixture({ setUp: { setup: { phase: 'idle' } }, width: 320 })
export const notSetUpBrowser = fixture({
  setUp: { setup: { phase: 'browser', startedAt: 0, canReopen: true } }
})
export const notSetUpCodexDevice = fixture({
  agent: 'codex',
  setUp: {
    setup: {
      phase: 'device',
      startedAt: 0,
      userCode: 'K7QF-2XRM',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: 0
    }
  }
})
export const notSetUpPaste = fixture({ setUp: { setup: { phase: 'paste', reason: 'chosen' } } })
export const notSetUpFailed = fixture({ setUp: { setup: { phase: 'failed', error: 'denied' } } })
/** Set up finished: Start {{agent}} releases the held launch. */
export const notSetUpDone = fixture({ setUp: { setup: { phase: 'saved' }, ready: true } })
