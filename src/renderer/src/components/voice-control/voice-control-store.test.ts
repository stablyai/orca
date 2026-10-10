// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  publishVoiceControlAgentActivity,
  publishVoiceControlState,
  publishVoiceControlToolActivity,
  publishVoiceControlTranscript,
  resetVoiceControl,
  useVoiceControlUi
} from './voice-control-store'

function harness() {
  return renderHook(() => useVoiceControlUi())
}

describe('voice-control-store', () => {
  beforeEach(() => resetVoiceControl())

  it('tracks per-agent activity with spoken names and drops agents that go idle', () => {
    const { result } = harness()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'p1',
        activity: 'speaking',
        spokenName: 'oak'
      })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'p2',
        activity: 'thinking',
        spokenName: 'oak'
      })
    })
    expect(result.current.agents).toEqual({
      p1: { activity: 'speaking', spokenName: 'oak' },
      p2: { activity: 'thinking', spokenName: 'oak' }
    })
    act(() => {
      publishVoiceControlAgentActivity({ sessionId: 's1', paneKey: 'p1', activity: 'idle' })
    })
    expect(result.current.agents).toEqual({ p2: { activity: 'thinking', spokenName: 'oak' } })
  })

  it('clears agents, tool activity, and transcript when the session ends', () => {
    const { result } = harness()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({ sessionId: 's1', paneKey: 'p1', activity: 'speaking' })
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'list_agents' })
      publishVoiceControlTranscript({ speaker: 'user', text: 'hello' })
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'list_agents' })
      publishVoiceControlState({ sessionId: null, state: 'idle' })
    })
    expect(result.current.agents).toEqual({})
    expect(result.current.transcript).toEqual([])
    expect(result.current.toolActivity).toBeNull()
  })

  it('narrates known tools with localized labels and hides internal ones', () => {
    const { result } = harness()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'run_command' })
    })
    expect(result.current.toolActivity).toBe('Running a command…')
    act(() => {
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'message_agent', target: 'oak' })
    })
    expect(result.current.toolActivity).toBe('Waiting for oak to reply…')
    act(() => {
      // Internal diagnostics (roster snapshot, sideband notes) never reach the pill.
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'sideband', detail: 'noise' })
    })
    expect(result.current.toolActivity).toBe('Waiting for oak to reply…')
  })

  it('clears tool narration when a reply starts speaking or the user talks again', () => {
    const { result } = harness()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'run_command' })
    })
    expect(result.current.toolActivity).not.toBeNull()
    act(() => {
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'run:run-1',
        activity: 'speaking',
        spokenName: 'update'
      })
    })
    expect(result.current.toolActivity).toBeNull()
    act(() => {
      publishVoiceControlToolActivity({ sessionId: 's1', tool: 'list_agents' })
      publishVoiceControlTranscript({ speaker: 'user', text: 'never mind' })
    })
    expect(result.current.toolActivity).toBeNull()
  })

  it('bounds the transcript to the newest lines', () => {
    const { result } = harness()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      for (let index = 0; index < 25; index += 1) {
        publishVoiceControlTranscript({ speaker: 'user', text: `line ${index}` })
      }
    })
    expect(result.current.transcript).toHaveLength(20)
    expect(result.current.transcript.at(-1)?.text).toBe('line 24')
  })
})
