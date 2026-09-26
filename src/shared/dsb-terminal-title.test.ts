import { describe, expect, it } from 'vitest'
import { isClaudeAgent as isIdentityClaudeAgent, getAgentLabel } from './agent-title-identity'
import { isDsbWorkingTitle, isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'
import { isClaudeAgent, resolveTerminalTitleAgentType } from './terminal-title-agent-type'

const WORKING = '⠼ - Waiting for response… - DeepSeek Build'
const CLAUDE_MENTION = '⠋ Review DeepSeek Build integration'

describe('DeepSeek Build terminal titles', () => {
  it('matches the product segment and not a mention inside another task', () => {
    expect(isDeepSeekBuildTerminalTitle('DeepSeek Build')).toBe(true)
    expect(isDeepSeekBuildTerminalTitle('my-project - DeepSeek Build')).toBe(true)
    expect(isDeepSeekBuildTerminalTitle(WORKING)).toBe(true)
    expect(isDeepSeekBuildTerminalTitle(CLAUDE_MENTION)).toBe(false)
    expect(isDeepSeekBuildTerminalTitle('Warning: DeepSeek Build')).toBe(false)
  })

  it('treats spinner and activity segments as a turn in progress', () => {
    expect(isDsbWorkingTitle(WORKING)).toBe(true)
    expect(isDsbWorkingTitle('⠼ - DeepSeek Build')).toBe(true)
    expect(isDsbWorkingTitle('Waiting - DeepSeek Build')).toBe(true)
    expect(isDsbWorkingTitle('Thinking - DeepSeek Build')).toBe(true)
    expect(isDsbWorkingTitle('DeepSeek Build')).toBe(false)
    expect(isDsbWorkingTitle('my-project - DeepSeek Build')).toBe(false)
    expect(isDsbWorkingTitle('Thinking about lunch - DeepSeek Build')).toBe(false)
    expect(isDsbWorkingTitle(CLAUDE_MENTION)).toBe(false)
  })

  it('keeps a Claude task that mentions DeepSeek Build on both title classifiers', () => {
    expect(isClaudeAgent(CLAUDE_MENTION)).toBe(true)
    expect(isIdentityClaudeAgent(CLAUDE_MENTION)).toBe(true)
    expect(resolveTerminalTitleAgentType(CLAUDE_MENTION)).toBe('claude')
    expect(getAgentLabel(CLAUDE_MENTION)).toBe('Claude Code')
    expect(resolveTerminalTitleAgentType(WORKING)).toBe('dsb')
    expect(getAgentLabel(WORKING)).toBe('DeepSeek Build')
    expect(isClaudeAgent(WORKING)).toBe(false)
    expect(isIdentityClaudeAgent(WORKING)).toBe(false)
  })
})
