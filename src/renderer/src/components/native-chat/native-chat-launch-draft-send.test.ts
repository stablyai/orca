import { describe, expect, it } from 'vitest'
import {
  agentInputLineCleared,
  planNativeChatLaunchDraftSend,
  resolveNativeChatLaunchDraftSend
} from './native-chat-launch-draft-send'
import {
  AGENT_TUI_CLEAR_INPUT_LINE,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-tui-input-clear'

const SEEDED = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

/** Claude's frame: the input line and its continuation rows sit last. */
const screenHoldingDraft = [
  '  ▘▘ ▝▝    ~/repo',
  '────────────────────────────────────────',
  '❯ Linked Linear issue: ABC-123',
  '  https://linear.app/x/issue/ABC-123',
  '────────────────────────────────────────'
].join('\n')

const screenPlaceholder = [
  '  ▘▘ ▝▝    ~/repo',
  '────────────────────────────────────────',
  '❯ Try "create a util logging.py that..."',
  '────────────────────────────────────────'
].join('\n')

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
    const samePrefixEdit = [
      '────────────────────────────────────────',
      '❯ Linked Linear but terminal-side text changed',
      '────────────────────────────────────────'
    ].join('\n')

    const result = resolveNativeChatLaunchDraftSend({
      launchDraft: { agent: 'codex', text: SEEDED },
      launchDraftResolved: false,
      agent: 'codex',
      readScreen: () => samePrefixEdit
    })
    expect(result.plan.kind).toBe('replace-draft')
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

describe('agentInputLineCleared', () => {
  it('confirms only an observably empty prompt', () => {
    expect(agentInputLineCleared('› \n  gpt-5.6 · ~/repo')).toBe(true)
  })

  it('does not call a different nonempty prompt cleared', () => {
    const edited = [
      '────────────────────────────────────────',
      '❯ issue: ABC-123 residue after a cursor-middle clear',
      '────────────────────────────────────────'
    ].join('\n')
    expect(agentInputLineCleared(edited)).toBe(false)
  })

  it('does not ignore nonempty continuation rows after an empty prompt row', () => {
    const residue = [
      '────────────────────────────────────────',
      '❯ ',
      '  suffix after a cursor-middle clear',
      '────────────────────────────────────────'
    ].join('\n')
    expect(agentInputLineCleared(residue)).toBe(false)
  })

  it('treats placeholders and parked drafts as unconfirmed', () => {
    expect(agentInputLineCleared(screenPlaceholder)).toBe(false)
    expect(agentInputLineCleared(screenHoldingDraft)).toBe(false)
  })

  it('treats an unreadable screen as unconfirmed', () => {
    expect(agentInputLineCleared(null)).toBe(false)
    expect(agentInputLineCleared('unparseable')).toBe(false)
  })

  it('reads an empty prompt through serializer ANSI', () => {
    expect(agentInputLineCleared(`[2m❯[0m `)).toBe(true)
  })
})
