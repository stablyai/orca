import { describe, expect, it } from 'vitest'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

describe('GitLab Duo terminal title', () => {
  it('identifies the title Duo sets at startup', () => {
    expect(resolveExplicitTerminalTitleAgentType('GitLab Duo CLI')).toBe('gitlab-duo')
  })

  it('does not claim task text that mentions Duo', () => {
    expect(resolveExplicitTerminalTitleAgentType('fix GitLab Duo CLI docs')).toBeNull()
  })
})
