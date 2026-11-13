// CHAT-RENEW-INPLACE: the in-place renewal, step by step, on all three surfaces (a launch held on the
// expired sign-in, a running terminal, a structured chat). design-squad's per-step copy.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  CloudAgentSignInStrip,
  CloudStripLayer,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import type { CloudStripModel } from './cloud-agent-strip-model'
import { cloudAgentStripModel } from './cloud-agent-strip-model'
import { cloudAgentAwaitingStartStripModel } from './cloud-agent-setup-strip-model'
import { cloudChatRunningStripModel, cloudRunningStripModel } from './cloud-running-strip-model'
import { cloudRenewInPlaceModel } from './cloud-renew-in-place'

const noop = (): void => {}
const ACTIONS: CloudStripActions = {
  primary: noop,
  submitCode: noop,
  pasteCode: noop,
  useCode: noop,
  useApiKey: noop,
  cancel: noop,
  openSettings: noop
}

type Surface = 'held' | 'terminal' | 'chat'
type Step = 'expired' | 'browser' | 'checking' | 'rejected' | 'renewed'

const SETUP: Record<Exclude<Step, 'renewed'>, OrcaCloudAgentSetup> = {
  expired: { phase: 'idle' },
  browser: { phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true },
  checking: {
    phase: 'browser',
    startedAt: 0,
    canReopen: true,
    acceptsCode: true,
    code: 'checking'
  },
  rejected: { phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true, code: 'rejected' }
}

function expiredModel(surface: Surface): CloudStripModel {
  const strip = { phase: 'expired' as const, agent: 'claude' as const }
  return surface === 'held'
    ? cloudAgentStripModel({
        agent: 'claude',
        reason: 'accountExpired',
        view: null,
        hostLabel: '',
        t: translate
      })
    : surface === 'chat'
      ? cloudChatRunningStripModel(strip, translate)
      : cloudRunningStripModel(strip, translate)
}

function stepModel(surface: Surface, step: Step): CloudStripModel {
  if (step !== 'renewed') {
    return cloudRenewInPlaceModel({
      agent: 'claude',
      expired: expiredModel(surface),
      setup: SETUP[step],
      t: translate
    })
  }
  const renewed = { phase: 'renewed' as const, agent: 'claude' as const, resumable: true }
  // Step 5 is each surface's own: held waits for Start (team-lead B), the terminal offers Restart
  // (RA-11), the chat's next message uses the renewed sign-in.
  return surface === 'held'
    ? cloudAgentAwaitingStartStripModel({
        agent: 'claude',
        awaiting: 'renewed',
        queuedPrompt: true,
        t: translate
      })
    : surface === 'chat'
      ? cloudChatRunningStripModel(renewed, translate)
      : cloudRunningStripModel(renewed, translate)
}

function Frame({
  surface,
  step,
  width
}: {
  surface: Surface
  step: Step
  width: number
}): React.JSX.Element {
  return (
    <div className="bg-background p-4">
      <div
        className="relative h-[220px] overflow-hidden rounded-md border border-border bg-background"
        style={{ width }}
      >
        <CloudStripLayer>
          <CloudAgentSignInStrip
            model={stepModel(surface, step)}
            prompt={surface === 'held' ? 'Fix the flaky auth test and open a PR' : null}
            width={cloudStripWidth(width)}
            actions={ACTIONS}
          />
        </CloudStripLayer>
      </div>
    </div>
  )
}

const fixture = (surface: Surface, step: Step, width = 900) =>
  defineFixture({
    width: width + 40,
    render: () => <Frame surface={surface} step={step} width={width} />
  })

export const heldExpired = fixture('held', 'expired')
export const heldBrowser = fixture('held', 'browser')
export const heldChecking = fixture('held', 'checking')
export const heldRejected = fixture('held', 'rejected')
export const heldRenewed = fixture('held', 'renewed')
export const terminalExpired = fixture('terminal', 'expired')
export const terminalBrowser = fixture('terminal', 'browser')
export const terminalChecking = fixture('terminal', 'checking')
export const terminalRejected = fixture('terminal', 'rejected')
export const terminalRenewed = fixture('terminal', 'renewed')
export const chatExpired = fixture('chat', 'expired')
export const chatBrowser = fixture('chat', 'browser')
export const chatChecking = fixture('chat', 'checking')
export const chatRejected = fixture('chat', 'rejected')
export const chatRenewed = fixture('chat', 'renewed')
/** Narrow: the code field stacks under the text, and "Renew in Settings" gets its own line. */
export const chatBrowserNarrow = fixture('chat', 'browser', 440)
export const terminalRejectedNarrow = fixture('terminal', 'rejected', 440)
