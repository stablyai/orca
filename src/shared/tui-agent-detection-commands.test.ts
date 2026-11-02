import { describe, expect, it } from 'vitest'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

describe('tui agent detection commands', () => {
  it('detects Gajae Code from either gjc or gajae-code on PATH', () => {
    expect(
      resolveDetectedTuiAgentIds(KNOWN_TUI_AGENT_DETECTION_COMMANDS, new Set(['gjc']), 'darwin')
    ).toEqual(['gajae-code'])
    expect(
      resolveDetectedTuiAgentIds(
        KNOWN_TUI_AGENT_DETECTION_COMMANDS,
        new Set(['gajae-code']),
        'linux'
      )
    ).toEqual(['gajae-code'])
  })
})
