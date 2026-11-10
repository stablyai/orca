// Cloud-start G inside the "Set up Orca Cloud" panel: the Agent row from the Orca account's setup.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { OrcaCloudAgentSetupRowModel } from '@/lib/orca-cloud/orca-cloud-agent-setup-row'
import { OrcaCloudSetupPanel } from './OrcaCloudSetupPanel'
import { cloudStartAgentStep } from './cloud-start-agent-step'
import type { CloudSetupStep } from './cloud-start-model'

const BASE: CloudSetupStep[] = [
  { id: 'account', state: 'done', detail: 'neil@acme.dev' },
  { id: 'github', state: 'needed', need: 'github', canFix: true }
]

function panel(row: OrcaCloudAgentSetupRowModel) {
  return defineFixture({
    width: 560,
    render: () => {
      const agent = cloudStartAgentStep({ id: 'agent', state: 'optional' }, row, translate)
      return (
        <div className="bg-background p-4">
          <OrcaCloudSetupPanel steps={agent ? [...BASE, agent] : BASE} />
        </div>
      )
    }
  })
}

export const gFromAccount = panel({ kind: 'covered', agent: 'claude', via: 'account' })
export const gTeamKey = panel({ kind: 'covered', agent: 'codex', via: 'team' })
export const gNotSetUp = panel({ kind: 'notSetUp', agent: 'claude' })
export const gKillSwitch = panel({ kind: 'killSwitch', agent: 'claude' })
export const gSignedOut = panel({ kind: 'signedOut', agent: 'claude' })
export const gLoading = panel({ kind: 'loading', agent: 'claude' })
