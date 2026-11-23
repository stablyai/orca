import { describe, expect, it } from 'vitest'
import { getAgentLabel } from '../agent-title-identity'
import { detectAgentStatusFromTitle } from '../agent-title-status'
import {
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from '../terminal-title-agent-type'

describe('Gray terminal titles', () => {
  it.each([
    ['my project \u00B7 gray', 'idle'],
    ['\u25CF my project \u00B7 gray', 'working'],
    ['zsh | \u25CF my project \u00B7 gray', 'working']
  ])('identifies %s as Gray with %s status', (title, status) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('gray')
    expect(resolveTerminalTitleAgentType(title)).toBe('gray')
    expect(getAgentLabel(title)).toBe('Gray')
    expect(detectAgentStatusFromTitle(title)).toBe(status)
  })

  it.each([
    ['✳ change color · gray', 'Claude Code'],
    ['π coding · gray', 'Pi']
  ])('preserves the owner of %s', (title, label) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).not.toBe('gray')
    expect(resolveTerminalTitleAgentType(title)).not.toBe('gray')
    expect(getAgentLabel(title)).toBe(label)
  })
})
