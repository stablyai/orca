// Cloud-start G: the Agent row in the "Set up Orca Cloud" panel, every state.
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { OrcaCloudAgentSetupRowModel } from '@/lib/orca-cloud/orca-cloud-agent-setup-row'
import { OrcaCloudAgentSetupRowView } from './OrcaCloudAgentSetupRow'

function fixture(...rows: OrcaCloudAgentSetupRowModel[]) {
  return defineFixture({
    width: 520,
    render: () => (
      <div className="space-y-2 bg-background p-4">
        {rows.map((row) => (
          <OrcaCloudAgentSetupRowView
            key={`${row.kind}:${row.kind === 'hidden' ? '' : row.agent}:${row.kind === 'covered' ? row.via : ''}`}
            row={row}
          />
        ))}
      </div>
    )
  })
}

export const fromAccount = fixture({ kind: 'covered', agent: 'claude', via: 'account' })
export const teamKey = fixture({ kind: 'covered', agent: 'codex', via: 'team' })
export const notSetUp = fixture({ kind: 'notSetUp', agent: 'claude' })
export const expired = fixture({ kind: 'expired', agent: 'claude' })
export const killSwitch = fixture({ kind: 'killSwitch', agent: 'claude' })
export const signedOut = fixture({ kind: 'signedOut', agent: 'claude' })
export const loading = fixture({ kind: 'loading', agent: 'claude' })
export const error = fixture({ kind: 'error', agent: 'codex' })
export const allStates = fixture(
  { kind: 'covered', agent: 'claude', via: 'account' },
  { kind: 'covered', agent: 'codex', via: 'team' },
  { kind: 'notSetUp', agent: 'claude' },
  { kind: 'killSwitch', agent: 'claude' },
  { kind: 'signedOut', agent: 'claude' }
)
