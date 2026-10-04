import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  paneShownSubagentTranscriptPath,
  subagentTranscriptPathForParent
} from './pane-subagent-view-source'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const PARENT_TRANSCRIPT = '/home/u/.claude/projects/p/693d.jsonl'

const CLAUDE_PARENT: AgentStatusEntry = {
  paneKey: PANE,
  state: 'working',
  prompt: 'Parent',
  updatedAt: 1,
  stateStartedAt: 1,
  stateHistory: [],
  agentType: 'claude',
  worktreeId: 'wt-1',
  providerSession: { key: 'session_id', id: 's1', transcriptPath: PARENT_TRANSCRIPT }
}

describe('subagentTranscriptPathForParent', () => {
  it("names the subagent's transcript beside a readable Claude parent's", () => {
    expect(subagentTranscriptPathForParent(CLAUDE_PARENT, true, 'a1')).toBe(
      '/home/u/.claude/projects/p/693d/subagents/agent-a1.jsonl'
    )
  })

  it('refuses a parent this renderer cannot read (Model-A SSH, unknown host)', () => {
    expect(subagentTranscriptPathForParent(CLAUDE_PARENT, false, 'a1')).toBeNull()
  })

  it.each<[string, AgentStatusEntry | undefined]>([
    ['a non-Claude parent', { ...CLAUDE_PARENT, agentType: 'codex' }],
    ['a parent without a transcript path', { ...CLAUDE_PARENT, providerSession: undefined }],
    ['no parent at all', undefined]
  ])('refuses %s', (_label, entry) => {
    expect(subagentTranscriptPathForParent(entry, true, 'a1')).toBeNull()
  })
})

describe('paneShownSubagentTranscriptPath', () => {
  const view = { agentId: 'a1', name: 'Explore', parentTranscriptPath: PARENT_TRANSCRIPT }

  it('shows the chosen subagent of the session it was chosen in', () => {
    expect(
      paneShownSubagentTranscriptPath(
        {
          agentStatusByPaneKey: { [PANE]: CLAUDE_PARENT },
          paneSubagentViewByPaneKey: { [PANE]: view }
        },
        PANE,
        true
      )
    ).toBe('/home/u/.claude/projects/p/693d/subagents/agent-a1.jsonl')
  })

  it('shows nothing once the pane has moved on to another session', () => {
    const nextSession: AgentStatusEntry = {
      ...CLAUDE_PARENT,
      providerSession: {
        key: 'session_id',
        id: 's2',
        transcriptPath: '/home/u/.claude/projects/p/9f1e.jsonl'
      }
    }
    expect(
      paneShownSubagentTranscriptPath(
        {
          agentStatusByPaneKey: { [PANE]: nextSession },
          paneSubagentViewByPaneKey: { [PANE]: view }
        },
        PANE,
        true
      )
    ).toBeNull()
  })

  it('shows nothing while the pane shows its own agent', () => {
    expect(
      paneShownSubagentTranscriptPath(
        { agentStatusByPaneKey: { [PANE]: CLAUDE_PARENT }, paneSubagentViewByPaneKey: {} },
        PANE,
        true
      )
    ).toBeNull()
  })
})
