import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

function ompLaunch(prompt: string): string {
  return buildAgentStartupPlan({ agent: 'omp', prompt, cmdOverrides: {}, platform: 'linux' })!
    .launchCommand
}

describe('OMP vibe launch prompt', () => {
  it('routes a leading /vibe through the Orca extension command', () => {
    expect(ompLaunch('/vibe fix the flaky test')).toContain("'/orca-vibe fix the flaky test'")
    expect(ompLaunch('/vibe')).toContain("'/orca-vibe'")
  })

  it('leaves other prompts alone', () => {
    expect(ompLaunch('/vibes check')).toContain("'/vibes check'")
    expect(ompLaunch('explain /vibe')).toContain("'explain /vibe'")
  })
})
