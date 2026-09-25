import { describe, expect, it } from 'vitest'
import {
  buildAgentSessionForkModalData,
  parseAgentSessionForkModalData
} from './agent-session-fork-modal-data'

describe('buildAgentSessionForkModalData', () => {
  it('keeps exactly the four fields, nulls included', () => {
    expect(
      buildAgentSessionForkModalData({
        sourceWorktreeId: 'repo::wt',
        launchSource: 'sidebar',
        preselectedPaneKey: null,
        transcript: null
      })
    ).toStrictEqual({
      sourceWorktreeId: 'repo::wt',
      launchSource: 'sidebar',
      preselectedPaneKey: null,
      transcript: null
    })
  })
})

describe('parseAgentSessionForkModalData', () => {
  it('round-trips sidebar data', () => {
    const data = {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'sidebar' as const,
      preselectedPaneKey: null,
      transcript: null
    }
    expect(parseAgentSessionForkModalData(buildAgentSessionForkModalData(data))).toEqual(data)
  })

  it('round-trips terminal data with a transcript', () => {
    const data = {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu' as const,
      preselectedPaneKey: 'tab-1:pane-1',
      transcript: { agent: 'gemini' as const, prompt: 'x' }
    }
    expect(parseAgentSessionForkModalData(buildAgentSessionForkModalData(data))).toEqual(data)
  })

  it('rejects missing ids, unknown launch sources and unknown agents', () => {
    expect(parseAgentSessionForkModalData({})).toBeNull()
    expect(
      parseAgentSessionForkModalData({ sourceWorktreeId: '', launchSource: 'sidebar' })
    ).toBeNull()
    expect(
      parseAgentSessionForkModalData({ sourceWorktreeId: 'x', launchSource: 'nope' })
    ).toBeNull()
    expect(
      parseAgentSessionForkModalData({
        sourceWorktreeId: 'x',
        launchSource: 'sidebar',
        transcript: { agent: 'nope', prompt: 'p' }
      })
    ).toMatchObject({ transcript: null })
  })

  it('drops a transcript without a prompt and a non-string pane key', () => {
    expect(
      parseAgentSessionForkModalData({
        sourceWorktreeId: 'x',
        launchSource: 'terminal_context_menu',
        preselectedPaneKey: 7,
        transcript: { agent: 'claude' }
      })
    ).toEqual({
      sourceWorktreeId: 'x',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: null,
      transcript: null
    })
  })
})
