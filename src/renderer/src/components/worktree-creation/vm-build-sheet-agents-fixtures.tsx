// The cloud build sheet's Agents row (spec §5b; redesign §5), every state, inside the real sheet.
// Re-exported by VmBuildSheet.fixture.tsx as VmBuildSheet:agents*.
import React, { useEffect, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  buildAgentsRowDensity,
  type BuildAgentsRowDensity,
  type BuildAgentsRowModel
} from '@/lib/orca-cloud/orca-cloud-build-agents-row'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  CLOUD_LOG,
  CLOUD_RECIPE,
  entry,
  NOW,
  seedFixtureRepo,
  sheet
} from './vm-build-sheet-fixture-support'
import {
  VmBuildCloudAgentsRowView,
  type DesktopKeySave,
  type VmBuildCloudAgentsRowActions
} from './cloud-agents-row/VmBuildCloudAgentsRowView'
import { VmBuildCloudAgentsMenu } from './cloud-agents-row/VmBuildCloudAgentsMenu'

const noop = (): void => {}
const ACTIONS: VmBuildCloudAgentsRowActions = {
  setUp: noop,
  cancel: noop,
  reopen: noop,
  copyCodeAndOpen: noop,
  dismissFailure: noop,
  retryLoad: noop,
  manage: noop,
  saveDesktopKey: noop,
  signInHere: noop,
  cancelSignInHere: noop
}

const CLOUD = entry({ provisioningLog: CLOUD_LOG }, CLOUD_RECIPE)

const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'active', label: 'nw@stably.ai' },
    codex: { state: 'active', label: 'nw@stably.ai' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: {
    defaults: { claude: 'sign-in', codex: 'key' },
    effective: { claude: { source: 'sign-in' }, codex: { source: 'key' } },
    coveredByKey: { claude: false, codex: true }
  }
}

function menu(offer: boolean): React.ReactNode {
  return (
    <VmBuildCloudAgentsMenu
      offer={offer}
      status={STATUS}
      keyKinds={{ claude: null, codex: 'team' }}
      sources={{ kind: 'ready', view: STATUS.sources }}
      onOpen={noop}
      onChoose={noop}
      onManage={noop}
      onUseKey={noop}
    />
  )
}

function agents(
  model: BuildAgentsRowModel,
  options: {
    density?: BuildAgentsRowDensity
    desktopKeySave?: DesktopKeySave
    queued?: boolean
    interact?: (frame: HTMLElement) => Promise<void>
  } = {}
) {
  const hasMenu = model.kind !== 'loading' && model.kind !== 'setup'
  return defineFixture({
    width: 760,
    setup: () => seedFixtureRepo(),
    interact: options.interact,
    render: () =>
      sheet(CLOUD, null, NOW, undefined, {
        cloudAgentsRow: (
          <VmBuildCloudAgentsRowView
            model={model}
            density={options.density ?? buildAgentsRowDensity(model)}
            actions={ACTIONS}
            menu={hasMenu ? menu(model.kind === 'offer' || model.kind === 'desktopKey') : undefined}
            desktopKeySave={options.desktopKeySave}
            queued={options.queued}
          />
        )
      })
  })
}

const ACCOUNT_BOTH: BuildAgentsRowModel = {
  kind: 'ready',
  covered: [
    { agent: 'claude', via: 'account' },
    { agent: 'codex', via: 'account' }
  ],
  label: 'nw@stably.ai',
  expiring: null
}

export const agentsAccount = agents(ACCOUNT_BOTH)
export const agentsAccountAndTeamKey = agents({
  kind: 'ready',
  covered: [
    { agent: 'claude', via: 'account' },
    { agent: 'codex', via: 'team' }
  ],
  label: null,
  expiring: null
})
export const agentsTeamKeyOnly = agents({
  kind: 'ready',
  covered: [{ agent: 'codex', via: 'team' }],
  label: null,
  expiring: null
})
export const agentsNotSetUp = agents({ kind: 'offer', agents: ['claude', 'codex'] })
export const agentsDesktopKeyOnly = agents({
  kind: 'desktopKey',
  key: { id: 'k1', agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: 'x4Qa' }
})
export const agentsDesktopKeyFailed = agents(
  {
    kind: 'desktopKey',
    key: { id: 'k1', agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: 'x4Qa' }
  },
  { desktopKeySave: { kind: 'failed', error: 'unavailable' } }
)
export const agentsKillSwitch = agents({ kind: 'killSwitch', agent: 'claude' })
export const agentsKillSwitchQueued = agents(
  { kind: 'killSwitch', agent: 'claude' },
  { queued: true }
)
export const agentsLoading = agents({ kind: 'loading' })
export const agentsSettingUpClaude = agents({
  kind: 'setup',
  agent: 'claude',
  setup: { phase: 'browser', startedAt: NOW - 8_000, canReopen: true },
  step: 1,
  of: 2
})
export const agentsSettingUpCodexDevice = agents({
  kind: 'setup',
  agent: 'codex',
  setup: {
    phase: 'device',
    startedAt: NOW - 12_000,
    userCode: 'K7QF-2M9D',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: NOW + 600_000
  },
  step: 2,
  of: 2
})
export const agentsSetupFailed = agents({ kind: 'failed', agent: 'claude', error: 'denied' })
export const agentsExpired = agents({ kind: 'expired', agent: 'claude' })
/** R1c: mounted ready, then within its renewal window: stays a line with a quiet Renew. */
export const agentsExpiringLine = agents({ ...ACCOUNT_BOTH, expiring: 'claude' })
/** R1b: mounted as a line, then expired: stays a line. */
export const agentsExpiredLine = agents({ kind: 'expired', agent: 'claude' }, { density: 'line' })
export const agentsError = agents({ kind: 'error' })
/** S1-b: the ⋯ menu open, Source per agent in this workspace. */
export const agentsMenu = agents(
  {
    kind: 'ready',
    covered: [
      { agent: 'claude', via: 'account' },
      { agent: 'codex', via: 'team' }
    ],
    label: null,
    expiring: null
  },
  {
    interact: async (frame) => {
      const trigger = frame.querySelector<HTMLButtonElement>('[aria-label="Agent sign-in options"]')
      trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
)

/**
 * For the layout-shift test: the row mounts in `start` and moves through states on a window event
 * (`orca-fixture-agents`, detail = a model), the way the store and main move it in the app.
 */
// The test sends well-formed models; this only keeps the event's `any` out of the row.
function isRowModel(value: unknown): value is BuildAgentsRowModel {
  return typeof value === 'object' && value !== null && 'kind' in value
}

function SteppedRow({ start }: { start: BuildAgentsRowModel }): React.JSX.Element {
  const [model, setModel] = useState(start)
  const [density] = useState(() => buildAgentsRowDensity(start))
  useEffect(() => {
    const onStep = (event: Event): void => {
      if (event instanceof CustomEvent && isRowModel(event.detail)) {
        setModel(event.detail)
      }
    }
    window.addEventListener('orca-fixture-agents', onStep)
    return () => window.removeEventListener('orca-fixture-agents', onStep)
  }, [])
  return (
    <VmBuildCloudAgentsRowView
      model={model}
      density={density}
      actions={ACTIONS}
      menu={model.kind === 'loading' || model.kind === 'setup' ? undefined : menu(false)}
    />
  )
}

function stepped(start: BuildAgentsRowModel) {
  return defineFixture({
    width: 760,
    setup: () => seedFixtureRepo(),
    render: () =>
      sheet(CLOUD, null, NOW, undefined, { cloudAgentsRow: <SteppedRow start={start} /> })
  })
}

export const agentsSteppedFromLoading = stepped({ kind: 'loading' })
export const agentsSteppedFromReady = stepped(ACCOUNT_BOTH)
