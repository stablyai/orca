import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  paneShownSubagentTranscriptPath,
  paneSubagentTranscriptPath,
  subagentTranscriptPathForParent
} from './pane-subagent-view-source'

// 'wt-local' is on this machine; any other worktree is on an SSH host this renderer cannot read.
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-local' ? null : 'ssh-host'
}))

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

describe('paneSubagentTranscriptPath', () => {
  const SUBAGENT_TRANSCRIPT = '/home/u/.claude/projects/p/693d/subagents/agent-a1.jsonl'

  function stateWith(entry: AgentStatusEntry, tabWorktreeId: string | null): AppState {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: paneSubagentTranscriptPath reads only these two maps; the connection lookup is mocked.
    return {
      agentStatusByPaneKey: { [PANE]: entry },
      tabsByWorktree: tabWorktreeId ? { [tabWorktreeId]: [{ id: 'tab-1' }] } : {}
    } as unknown as AppState
  }

  it("judges readability by the pane's tab worktree, as the cover does", () => {
    const entry = { ...CLAUDE_PARENT, worktreeId: 'wt-remote' }
    expect(paneSubagentTranscriptPath(stateWith(entry, 'wt-local'), PANE, 'a1')).toBe(
      SUBAGENT_TRANSCRIPT
    )
    expect(
      paneSubagentTranscriptPath(
        stateWith({ ...CLAUDE_PARENT, worktreeId: 'wt-local' }, 'wt-remote'),
        PANE,
        'a1'
      )
    ).toBeNull()
  })

  it('falls back to the entry worktree when no tab owns the pane', () => {
    expect(
      paneSubagentTranscriptPath(
        stateWith({ ...CLAUDE_PARENT, worktreeId: 'wt-local' }, null),
        PANE,
        'a1'
      )
    ).toBe(SUBAGENT_TRANSCRIPT)
  })

  it('refuses a pane whose worktree is unknown', () => {
    expect(
      paneSubagentTranscriptPath(
        stateWith({ ...CLAUDE_PARENT, worktreeId: undefined }, null),
        PANE,
        'a1'
      )
    ).toBeNull()
  })
})
