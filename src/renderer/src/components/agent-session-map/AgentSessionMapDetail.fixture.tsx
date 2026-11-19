import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  AgentMapNode,
  AgentMapNodeViewState
} from '../../../../shared/agent-session-map/agent-session-map-model'
import { AgentSessionMapDetail } from './AgentSessionMapDetail'

const node: AgentMapNode = {
  id: 'root',
  kind: 'main',
  label: 'Agent',
  firstTs: 1_700_000_000_000,
  lastTs: 1_700_000_078_000,
  toolCalls: [
    {
      callId: 't1',
      name: 'Bash',
      summary: 'pnpm test auth',
      state: 'completed',
      startTs: 1_700_000_001_500,
      endTs: 1_700_000_004_200,
      durationMs: 2700
    },
    {
      callId: 't2',
      name: 'Edit',
      summary: 'src/auth/session.ts',
      state: 'running',
      startTs: 1_700_000_076_500
    }
  ],
  turns: [
    {
      turnId: 'turn-1',
      state: 'completed',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_050_000,
      durationMs: 50_000
    }
  ],
  requests: [
    {
      kind: 'question',
      detail: 'Which token format should the refactor keep?',
      resolution: 'pending',
      ts: 1_700_000_075_000
    }
  ],
  promptCount: 1,
  filesTouched: ['src/auth/session.ts', 'src/auth/tokens.ts'],
  lastPromptText: 'Refactor the auth module'
}

const view: AgentMapNodeViewState = {
  nodeId: 'root',
  status: 'running',
  activeTool: node.toolCalls[1],
  toolCount: 2,
  completedToolCount: 1,
  failedToolCount: 0,
  promptCount: 1,
  lastStatusText: 'Editing src/auth/session.ts'
}

export const populated = defineFixture({
  width: 320,
  render: () => (
    <div className="h-[420px] w-full bg-background">
      <AgentSessionMapDetail node={node} view={view} onClose={() => {}} />
    </div>
  )
})
