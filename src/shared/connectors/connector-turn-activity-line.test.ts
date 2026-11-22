import { describe, expect, it } from 'vitest'
import { connectorTurnActivityLine } from './connector-turn-activity-line'

describe('connectorTurnActivityLine', () => {
  it.each([
    ['exec_command', '', 'Running a command'],
    ['apply_patch', 'a.ts', 'Editing a.ts'],
    ['WebSearch', 'slack streaming api', 'Searching the web for slack streaming api'],
    ['mcp__linear__create_issue', '{"title":"x"}', 'Using linear (create issue)'],
    ['Grep', '', 'Using Grep'],
    ['SomeNewTool', 'whatever', 'Using SomeNewTool']
  ])('%s %j reads %j', (name, input, line) => {
    expect(connectorTurnActivityLine(name, input)).toBe(line)
  })

  it('says nothing without a tool', () => {
    expect(connectorTurnActivityLine(undefined, 'x')).toBeUndefined()
    expect(connectorTurnActivityLine('  ', 'x')).toBeUndefined()
  })

  it('leaves out an input that looks like it holds a secret', () => {
    expect(
      connectorTurnActivityLine(
        'Bash',
        'curl -H "Authorization: Bearer abc123def456" https://x.dev'
      )
    ).toBe('Running a command')
    expect(connectorTurnActivityLine('Bash', 'export API_KEY=sk-ant-abcdefgh12345678')).toBe(
      'Running a command'
    )
  })

  it('keeps one line within the limit', () => {
    const line = connectorTurnActivityLine('Bash', `echo ${'a'.repeat(300)}\nsecond line`)
    expect(line).toHaveLength(120)
    expect(line?.endsWith('…')).toBe(true)
  })
})
