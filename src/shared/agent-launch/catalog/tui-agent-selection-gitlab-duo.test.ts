import { describe, expect, it } from 'vitest'
import { pickTuiAgent } from './tui-agent-selection'
import { pickSourceControlLaunchAgent } from '../../source-control/ai/source-control-launch-agent-selection'

// A detected `glab` may predate `glab duo cli`, so Duo is offered but never chosen by fallback.
describe('GitLab Duo agent selection', () => {
  it('does not fall back to Duo when only glab is detected', () => {
    expect(pickTuiAgent(null, ['gitlab-duo'])).toBeNull()
    expect(pickTuiAgent(null, ['gitlab-duo', 'codex'])).toBe('codex')
    expect(
      pickSourceControlLaunchAgent({ defaultAgent: null, detectedAgents: ['gitlab-duo'] })
    ).toBeNull()
  })

  it('keeps an explicit Duo choice', () => {
    expect(pickTuiAgent('gitlab-duo', ['gitlab-duo'])).toBe('gitlab-duo')
    expect(
      pickSourceControlLaunchAgent({ defaultAgent: 'gitlab-duo', detectedAgents: ['gitlab-duo'] })
    ).toBe('gitlab-duo')
  })
})
