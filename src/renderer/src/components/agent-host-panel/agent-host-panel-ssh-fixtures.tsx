// AgentHostPanel fixtures for a classic SSH host (no Orca server): status and code sign-in over
// SSH exec (spec §4 annotations 4–5, Q8). Re-exported from AgentHostPanel.fixture.tsx.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { SshAgentSignInFlow } from '../../../../shared/ssh-agent-sign-in-types'
import { HostFixture } from './agent-host-panel-host-fixtures'
import type { HostAgentPanelRow } from './host-agents-panel-model'

const noop = (): void => {}
const NO_KEYS: AgentApiKeySummary[] = []
const ROWS: HostAgentPanelRow[] = [
  { agent: 'claude', state: 'signedOut', canSignOut: false },
  { agent: 'codex', state: 'signedIn', canSignOut: true }
]
const SIGNED_OUT: HostAgentPanelRow[] = [
  { agent: 'claude', state: 'signedOut', canSignOut: false },
  { agent: 'codex', state: 'signedOut', canSignOut: false }
]

function flow(patch: Partial<SshAgentSignInFlow> & Pick<SshAgentSignInFlow, 'agent' | 'phase'>) {
  return { flowId: 'f1', targetId: 'build-01', ...patch }
}

function ssh(
  flows: Partial<Record<'claude' | 'codex', SshAgentSignInFlow>> = {},
  rows: HostAgentPanelRow[] = ROWS,
  availability: 'available' | 'disconnected' = 'available'
): React.JSX.Element {
  return (
    <HostFixture
      kind="sshClassic"
      host="build-01"
      availability={availability}
      rows={rows}
      keys={NO_KEYS}
      lastChecked={availability === 'available' ? null : 'Nov 9, 2026'}
      codeSignIn={{
        flows,
        start: noop,
        actions: { submit: noop, cancel: noop, retry: noop, openLink: noop, copyAndOpen: noop }
      }}
    />
  )
}

export const sshClassic = defineFixture({ width: 1000, render: () => ssh() })

export const sshClassicPaste = defineFixture({
  width: 1000,
  render: () =>
    ssh({
      claude: flow({
        agent: 'claude',
        phase: 'needsCode',
        url: 'https://claude.ai/oauth/authorize?code=true'
      })
    })
})

export const sshClassicDevice = defineFixture({
  width: 1000,
  render: () =>
    ssh(
      {
        codex: flow({
          agent: 'codex',
          phase: 'device',
          url: 'https://auth.openai.com/codex/device',
          userCode: 'K7QX-M2PL'
        })
      },
      SIGNED_OUT
    )
})

export const sshClassicChecking = defineFixture({
  width: 1000,
  render: () => ssh({ claude: flow({ agent: 'claude', phase: 'submitting' }) })
})

export const sshClassicFailed = defineFixture({
  width: 1000,
  render: () => ssh({ claude: flow({ agent: 'claude', phase: 'failed', error: 'rejected' }) })
})

export const sshClassicDisconnected = defineFixture({
  width: 1000,
  render: () => ssh({}, ROWS, 'disconnected')
})

/** An API key signs Codex in while its ChatGPT login on the host goes unused (hasLogin). */
export const sshClassicKeyOverrides = defineFixture({
  width: 1000,
  render: () =>
    ssh({}, [
      { agent: 'claude', state: 'signedIn', canSignOut: true },
      { agent: 'codex', state: 'apiKeyOverrides', canSignOut: false }
    ])
})
