import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STATES } from '../../../shared/agent-status-types'
import type { AgentRowState } from './agent-row-decay-state'
import { formatAgentToolPreview, showsAgentToolPreview } from './agent-row-tool-preview'

const TOOL = { toolName: 'bash', toolInput: 'rm -rf build/' }
const ROW_STATES: readonly AgentRowState[] = [...AGENT_STATUS_STATES, 'idle', 'unverifiable']

describe('showsAgentToolPreview', () => {
  it('covers exactly the two states whose tool fields describe live work', () => {
    // Why: enumerate every row state so a new one has to make this decision explicitly
    // rather than defaulting into showing a stale tool.
    const showing = ROW_STATES.filter((state) => showsAgentToolPreview(state))

    expect(showing).toEqual(['working', 'waiting'])
  })

  it('shows nothing when the state is unknown', () => {
    expect(showsAgentToolPreview(null)).toBe(false)
    expect(showsAgentToolPreview(undefined)).toBe(false)
  })
})

describe('formatAgentToolPreview', () => {
  it('names what a blocked approval is waiting on', () => {
    expect(formatAgentToolPreview(TOOL, 'waiting')).toBe('bash: rm -rf build/')
  })

  it('names the running tool while working', () => {
    expect(formatAgentToolPreview(TOOL, 'working')).toBe('bash: rm -rf build/')
  })

  it('keeps a resolved tool off every other state', () => {
    for (const state of ROW_STATES.filter((candidate) => !showsAgentToolPreview(candidate))) {
      expect(formatAgentToolPreview(TOOL, state)).toBe('')
    }
  })

  it('shows nothing on a wait that carries no tool', () => {
    // Why: a question-style wait sets no tool fields; it must not borrow an earlier one.
    expect(formatAgentToolPreview({}, 'waiting')).toBe('')
  })

  it('falls back to the bare tool name when the input is not previewable', () => {
    expect(formatAgentToolPreview({ toolName: 'edit' }, 'waiting')).toBe('edit')
  })

  it('ignores whitespace-only fields', () => {
    expect(formatAgentToolPreview({ toolName: '  ', toolInput: '  ' }, 'working')).toBe('')
  })
})
