import { describe, expect, it } from 'vitest'
import { watchPromptReplyFromAgent } from './watch-prompt-reply'

const ESCAPE = String.fromCharCode(27)

describe('watchPromptReplyFromAgent', () => {
  it('answers an approval envelope with the agent accept key and Escape', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'blocked',
        agent: 'claude',
        interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm build' } })
      })
    ).toEqual({ allow: '1', deny: ESCAPE })
  })

  it('uses Enter for an OpenCode approval envelope', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'waiting',
        agent: 'opencode',
        interactivePrompt: JSON.stringify({ approval: { tool: 'shell' } }),
        lastAssistantMessage: 'Allow? (y/n)'
      })
    ).toEqual({ allow: '\r', deny: ESCAPE })
  })

  it('prefers a numbered yes/no menu over the envelope', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'blocked',
        agent: 'claude',
        interactivePrompt: JSON.stringify({ approval: { tool: 'Bash' } }),
        lastAssistantMessage: 'Proceed?\n1. Yes\n2. No, and tell Claude what to do differently'
      })
    ).toEqual({ allow: '1', deny: '2' })
  })

  it('maps Allow to the one-time yes when the menu also offers always', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'blocked',
        lastAssistantMessage:
          "Allow this tool call?\n1. Yes\n2. Yes, and don't ask again this session\n3. No"
      })
    ).toEqual({ allow: '1', deny: '3' })
  })

  it('answers an explicit y/n prompt', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'waiting',
        lastAssistantMessage: 'Allow running `rm -rf build`? (y/n)'
      })
    ).toEqual({ allow: 'y', deny: 'n' })
  })

  it('stays quiet for a working agent, prose, and an unclassifiable menu', () => {
    expect(
      watchPromptReplyFromAgent({
        state: 'working',
        lastAssistantMessage: 'Allow? (y/n)'
      })
    ).toBeNull()
    expect(
      watchPromptReplyFromAgent({
        state: 'blocked',
        lastAssistantMessage: 'I need your permission to run this Bash command.'
      })
    ).toBeNull()
    expect(
      watchPromptReplyFromAgent({
        state: 'blocked',
        lastAssistantMessage: 'Choose:\n1. Red\n2. Blue'
      })
    ).toBeNull()
    expect(
      watchPromptReplyFromAgent({
        state: 'done',
        interactivePrompt: JSON.stringify({ approval: { tool: 'Bash' } })
      })
    ).toBeNull()
  })
})
