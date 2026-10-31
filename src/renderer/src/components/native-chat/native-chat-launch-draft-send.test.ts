import { describe, expect, it } from 'vitest'
import {
  planNativeChatLaunchDraftSend,
  resolveNativeChatLaunchDraftSend
} from './native-chat-launch-draft-send'
import {
  AGENT_TUI_CLEAR_INPUT_LINE,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-tui-input-clear'

const SEEDED = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

const plan = (over: Partial<Parameters<typeof planNativeChatLaunchDraftSend>[0]> = {}) =>
  planNativeChatLaunchDraftSend({
    seededText: SEEDED,
    ...over
  })

describe('planNativeChatLaunchDraftSend', () => {
  it('replaces the parked draft even when the composer copy is unchanged', () => {
    expect(plan()).toEqual({
      kind: 'replace-draft',
      clearInput: buildAgentTuiClearInputForText(SEEDED),
      seededText: SEEDED
    })
  })

  it('does not submit a terminal-side edit that preserves the old short prefix', () => {
    const result = resolveNativeChatLaunchDraftSend({
      launchDraft: { agent: 'codex', text: SEEDED },
      launchDraftResolved: false,
      agent: 'codex',
      readInputLine: () => 'Linked Linear but terminal-side text changed'
    })
    expect(result.plan.kind).toBe('replace-draft')
    expect(result.sendOptions?.confirmCleared()).toBe(false)
  })

  it('confirms the clear once the input line reads empty', () => {
    const result = resolveNativeChatLaunchDraftSend({
      launchDraft: { agent: 'claude', text: SEEDED },
      launchDraftResolved: false,
      agent: 'claude',
      readInputLine: () => ''
    })
    expect(result.sendOptions?.confirmCleared()).toBe(true)
  })

  it('keeps the ordinary send path when nothing is parked on the line', () => {
    expect(plan({ seededText: null })).toEqual({ kind: 'default' })
    expect(plan({ seededText: '   ' })).toEqual({ kind: 'default' })
  })

  it('sizes a multi-line clear well past a single Ctrl+U', () => {
    const result = plan()
    expect(result.kind === 'replace-draft' && result.clearInput.length).toBeGreaterThan(
      AGENT_TUI_CLEAR_INPUT_LINE.length
    )
  })
})
