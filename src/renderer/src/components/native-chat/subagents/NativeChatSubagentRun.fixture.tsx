import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatSubagentGroupBlock } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'

const now = Date.now()

const block: NativeChatSubagentGroupBlock = {
  type: 'subagent-group',
  groupId: 'turn-1',
  agents: [
    {
      id: 'a1',
      label: 'Audit auth flow',
      state: 'working',
      tokens: 31_200,
      startedAt: now - 42_000,
      agentType: 'general-purpose',
      model: 'claude-opus-5-5',
      effort: 'high',
      operation: { toolName: 'Read', input: 'src/auth/session.ts' }
    },
    {
      id: 'a2',
      label: 'Fix flaky login test',
      state: 'working',
      tokens: 48_900,
      startedAt: now - 63_000,
      model: 'gpt-5.5',
      effort: 'xhigh',
      operation: { toolName: 'Bash', input: 'pnpm test login.spec.ts' }
    },
    {
      id: 'a3',
      label: 'Map token refresh',
      state: 'completed',
      tokens: 8_100,
      startedAt: now - 80_000,
      settledAt: now - 62_000,
      model: 'claude-haiku-4-5-20251001',
      lastMessage:
        'Refresh happens in **two** places:\n- `middleware.ts` retries once on 401\n- the client refreshes on a timer 60 s before expiry'
    },
    {
      id: 'a4',
      label: 'Bump the session cookie lifetime',
      state: 'failed',
      startedAt: now - 70_000,
      settledAt: now - 50_000,
      lastMessage: 'Could not write `config/session.ts`: the file is read-only in this workspace.'
    }
  ]
}

function Roster({ roster = block }: { roster?: NativeChatSubagentGroupBlock }) {
  return (
    <div className="native-chat-appearance p-4">
      <NativeChatSubagentRun block={roster} onOpenSubagent={() => {}} />
    </div>
  )
}

export const enriched = defineFixture({
  width: 560,
  render: () => <Roster />
})

async function openToggles(frame: HTMLElement, rounds: number): Promise<void> {
  // Each round opens what the previous one revealed: the summary first, then each row.
  for (let round = 0; round < rounds; round++) {
    for (const toggle of frame.querySelectorAll<HTMLButtonElement>(
      'button[aria-expanded="false"]'
    )) {
      toggle.click()
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

export const listed = defineFixture({
  width: 560,
  render: () => <Roster />,
  interact: (frame) => openToggles(frame, 1)
})

export const opened = defineFixture({
  width: 560,
  render: () => <Roster />,
  interact: (frame) => openToggles(frame, 2)
})

export const narrow = defineFixture({
  width: 320,
  render: () => <Roster />
})

export const single = defineFixture({
  width: 560,
  render: () => <Roster roster={{ ...block, agents: block.agents.slice(0, 1) }} />
})
