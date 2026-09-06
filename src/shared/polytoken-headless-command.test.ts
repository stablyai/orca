import { describe, expect, it } from 'vitest'
import { filterHeadlessOneShotAgentCommand } from './agent-headless-command'
import { isPolytokenHeadlessOneShotCommand } from './polytoken-headless-command'

describe('isPolytokenHeadlessOneShotCommand', () => {
  it('treats exec and daemon as headless, including behind global options', () => {
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', 'exec', 'summarize'])).toBe(true)
    expect(
      isPolytokenHeadlessOneShotCommand(['polytoken', '--working-dir', '/tmp/x', 'exec'])
    ).toBe(true)
    expect(
      isPolytokenHeadlessOneShotCommand(['polytoken', '--config-dir=/tmp/c', 'daemon', '--listen'])
    ).toBe(true)
  })

  it('keeps interactive launches and resumes as pane owners', () => {
    expect(isPolytokenHeadlessOneShotCommand(['polytoken'])).toBe(false)
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', 'new', '--prompt', 'exec'])).toBe(false)
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', 'continue', '0a6mht-drum'])).toBe(false)
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', 'attach', '0a6mht-drum'])).toBe(false)
    // Why: `--` ends option parsing, so a prompt that reads like a subcommand stays interactive.
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', '--', 'exec'])).toBe(false)
    expect(isPolytokenHeadlessOneShotCommand(['polytoken', '--working-dir', 'exec'])).toBe(false)
  })

  it('is wired into the shared headless one-shot table', () => {
    expect(
      filterHeadlessOneShotAgentCommand({ agent: 'polytoken' }, ['polytoken', 'exec', 'hi'])
    ).toBeNull()
    expect(filterHeadlessOneShotAgentCommand({ agent: 'polytoken' }, ['polytoken', 'new'])).toEqual(
      { agent: 'polytoken' }
    )
  })
})
