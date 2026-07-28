import { describe, expect, it } from 'vitest'
import { formatAgentTypeLabel } from '../presentation/agent-type-label'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { getAgentLabel, resolveTerminalTitleAgentType } from './terminal-title-agent-type'

describe('Qwen Code title identity', () => {
  it('maps Qwen Code product titles to qwen-code', () => {
    expect(resolveTerminalTitleAgentType('Qwen Code')).toBe('qwen-code')
    expect(resolveTerminalTitleAgentType('⠋ Qwen Code')).toBe('qwen-code')
    expect(resolveTerminalTitleAgentType('qwen ready')).toBe('qwen-code')
    expect(getAgentLabel('Qwen Code')).toBe('Qwen Code')
    expect(getAgentLabel('⠋ Qwen Code')).toBe('Qwen Code')
    expect(getAgentLabel('qwen ready')).toBe('Qwen Code')
  })

  it.each([
    ['Qwen Code', 'idle'],
    ['qwen ready', 'idle'],
    ['qwen working', 'working'],
    ['\u280b Qwen Code', 'working']
  ] as const)('classifies %s', (title, expectedStatus) => {
    expect(getAgentLabel(title)).toBe('Qwen Code')
    expect(detectAgentStatusFromTitle(title)).toBe(expectedStatus)
  })

  it.each(['~/qwen/working', 'qwen-code-fixtures ready'])(
    'does not classify path or hyphen false positive %s',
    (title) => {
      expect(getAgentLabel(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )

  it("maps 'qwen-code' to 'Qwen Code'", () => {
    expect(formatAgentTypeLabel('qwen-code')).toBe('Qwen Code')
  })
})
