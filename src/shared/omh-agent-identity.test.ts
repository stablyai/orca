import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-detection'
import { resolveCompatibleAgentTypeForOwner } from './agent-title-owner'
import { normalizeHookDisabledTuiAgents } from './managed-agent-hook-targets'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

describe('OMH agent identity', () => {
  it('reads the titles Orca synthesizes for an OMH pane', () => {
    expect(resolveExplicitTerminalTitleAgentType('OMH ready')).toBe('omh')
    expect(detectAgentStatusFromTitle('OMH ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('\u280b OMH')).toBe('working')
    expect(detectAgentStatusFromTitle('OMH - action required')).toBe('permission')
    expect(resolveExplicitTerminalTitleAgentType('fix omh install docs')).not.toBe('omh')
  })

  it('keeps an OMH owner when its wrapped Hermes reports or titles the pane', () => {
    expect(resolveCompatibleAgentTypeForOwner('hermes', 'omh')).toBe('omh')
    expect(resolveCompatibleAgentTypeForOwner('omh', 'hermes')).toBe('hermes')
    expect(resolveCompatibleAgentTypeForOwner('codex', 'omh')).toBe('codex')
  })

  it('recognizes the omh launcher as the foreground agent', () => {
    expect(
      recognizeAgentProcessFromCommandLine('/venv/bin/python /Users/me/.local/bin/omh')?.agent
    ).toBe('omh')
  })

  it('keeps Hermes hooks while OMH is enabled', () => {
    expect(normalizeHookDisabledTuiAgents(['hermes', 'cursor'])).toEqual(['cursor'])
    expect(normalizeHookDisabledTuiAgents(['hermes', 'omh'])).toEqual(['hermes', 'omh'])
  })
})
