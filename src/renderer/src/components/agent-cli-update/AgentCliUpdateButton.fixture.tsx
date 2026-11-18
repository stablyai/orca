import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentCliUpdateRun } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import { AgentCliUpdateButton } from './AgentCliUpdateButton'

const claude = {
  agent: 'claude',
  installedVersion: '2.1.250',
  latestVersion: '2.1.327',
  command: 'claude update',
  runnable: true
} as const

function button(run: AgentCliUpdateRun | null) {
  return defineFixture({
    width: 240,
    store: {
      agentCliUpdates: new Map([['', { updates: [claude], runs: run ? { claude: run } : {} }]])
    },
    render: () => (
      <div className="flex justify-end p-3">
        <AgentCliUpdateButton detectionTarget={{ kind: 'local' }} agent="claude" />
      </div>
    )
  })
}

export const idle = button(null)
export const updating = button({ phase: 'running' })
export const failed = button({ phase: 'failed', output: 'error' })
