import { describe, expect, it } from 'vitest'
import { isClineAgentTitle } from './agent-title-core'
import { getAgentLabel } from './agent-title-identity'
import { detectAgentStatusFromTitle } from './agent-title-status'
import {
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('Cline OSC title detection (STA-3906)', () => {
  // Observed on Windows: real `cline -i` sets the OSC title to exactly "Cline".
  it('classifies the live Cline identity title', () => {
    expect(isClineAgentTitle('Cline')).toBe(true)
    expect(getAgentLabel('Cline')).toBe('Cline')
    expect(resolveTerminalTitleAgentType('Cline')).toBe('cline')
    expect(resolveExplicitTerminalTitleAgentType('Cline')).toBe('cline')
    expect(detectAgentStatusFromTitle('Cline')).toBe('idle')
  })

  it('accepts decorated Cline identity frames and rejects task-text mentions', () => {
    for (const title of [
      'cline',
      'cline.exe',
      'Cline ready',
      'Cline working',
      'Cline - action required',
      '⠋ Cline',
      'zsh | Cline'
    ]) {
      expect(isClineAgentTitle(title)).toBe(true)
      expect(getAgentLabel(title)).toBe('Cline')
      expect(resolveTerminalTitleAgentType(title)).toBe('cline')
    }
    for (const title of [
      '⠋ use cline for the sidebar fix',
      'port the cline prompt',
      '~/cline-scratch',
      'cline-rules',
      'ask cline later'
    ]) {
      expect(isClineAgentTitle(title)).toBe(false)
      expect(getAgentLabel(title)).not.toBe('Cline')
      expect(resolveTerminalTitleAgentType(title)).not.toBe('cline')
    }
  })

  it('maps Cline identity frames to status without treating task-text mentions as activity', () => {
    expect(detectAgentStatusFromTitle('Cline')).toBe('idle')
    expect(detectAgentStatusFromTitle('cline.exe')).toBe('idle')
    expect(detectAgentStatusFromTitle('Cline ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('Cline working')).toBe('working')
    expect(detectAgentStatusFromTitle('Cline - action required')).toBe('permission')
    expect(detectAgentStatusFromTitle('⠋ Cline')).toBe('working')
    expect(detectAgentStatusFromTitle('zsh | Cline')).toBe('idle')

    for (const title of [
      'port the cline prompt',
      'ask cline later',
      '~/cline-scratch',
      'cline-rules'
    ]) {
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  })

  it('keeps Claude braille task text that mentions cline as Claude', () => {
    expect(resolveTerminalTitleAgentType('⠋ use cline for the sidebar fix')).toBe('claude')
    expect(getAgentLabel('⠋ use cline for the sidebar fix')).toBe('Claude Code')
    // Why: spinner still proves activity; the mention must not rebrand identity or invent Cline idle.
    expect(detectAgentStatusFromTitle('⠋ use cline for the sidebar fix')).toBe('working')
  })
})
