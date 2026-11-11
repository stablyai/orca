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
  reason,
  view = null,
  agent = 'claude',
  width = 900
}: {
  reason: CloudAgentStripReason
  view?: AgentSignInGateView | null
  agent?: HostAgentSignInAgent
  width?: number
}): React.JSX.Element {
  const model = cloudAgentStripModel({
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
        className="relative h-[220px] overflow-hidden rounded-md border border-border bg-background"
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
            prompt={PROMPT}
            width={cloudStripWidth(width)}
            actions={ACTIONS}
          />
        </CloudStripLayer>
        <pre className="absolute inset-x-0 bottom-0 top-20 p-3 font-mono text-xs text-muted-foreground">
          ~/acme/web $
        </pre>
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
