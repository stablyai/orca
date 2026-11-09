import type { HostAgentSignInReport } from '../../../../../../../shared/host-agent-sign-in-status'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { HostAgentSignInView } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { ServerListRow } from '../../../host-rows/ServerListRow'
import { HostAgentSignInChipList } from './HostAgentSignInChips'
import { HostAgentSignInRows } from './HostAgentSignInDialog'

const MIXED: HostAgentSignInReport = {
  checkedAt: 1,
  agents: [
    { agent: 'claude', state: 'signedIn', method: 'cliLogin' },
    { agent: 'codex', state: 'signedOut' }
  ]
}
const SIGNED_OUT: HostAgentSignInReport = {
  checkedAt: 1,
  agents: [
    { agent: 'claude', state: 'signedOut' },
    { agent: 'codex', state: 'signedOut' }
  ]
}

function Row({ name, view }: { name: string; view: HostAgentSignInView }): React.JSX.Element {
  return (
    <ServerListRow
      sectionId={name}
      name={name}
      chips={<HostAgentSignInChipList view={view} onOpen={() => {}} onRetry={() => {}} />}
      meta={<span>ws://10.0.0.4:6768 · v1.4.2</span>}
      status={{ label: 'Connected', tone: 'success' }}
    />
  )
}

export const serverRowChips = defineFixture({
  width: 760,
  render: () => (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      <Row name="api-refactor VM" view={{ phase: 'ready', report: MIXED }} />
      <Row name="build-box" view={{ phase: 'ready', report: SIGNED_OUT }} />
      <Row name="staging VM" view={{ phase: 'failed', report: null }} />
      <Row name="Older server" view={{ phase: 'unsupported' }} />
    </div>
  )
})

function Panel(props: {
  view: HostAgentSignInView
  errors?: { codex?: string; claude?: string }
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-5">
      <div className="text-lg font-semibold">Sign in agents</div>
      <p className="text-sm text-muted-foreground">
        Each agent signs in on api-refactor VM, and the login stays there. Orca only passes along
        the link and code.
      </p>
      <HostAgentSignInRows
        environmentId="vm"
        hostLabel="api-refactor VM"
        view={props.view}
        runningAgent={null}
        errors={props.errors ?? {}}
        onSignIn={() => {}}
        onRecheck={() => {}}
      />
    </div>
  )
}

export const signInStep = defineFixture({
  width: 460,
  render: () => <Panel view={{ phase: 'ready', report: MIXED }} />
})

export const codexSignInFailed = defineFixture({
  width: 460,
  render: () => (
    <Panel
      view={{ phase: 'ready', report: SIGNED_OUT }}
      errors={{ codex: 'Codex could not start device code sign-in.' }}
    />
  )
})

export const hostAsleep = defineFixture({
  width: 460,
  render: () => <Panel view={{ phase: 'asleep' }} />
})
