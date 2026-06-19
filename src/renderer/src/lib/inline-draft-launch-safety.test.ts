import { describe, expect, it } from 'vitest'
import { canUseInlineDraftLaunchPlan } from './inline-draft-launch-safety'

const PLAN = {
  agent: 'claude' as const,
  expectedProcess: 'claude',
  launchCommand: "claude --prefill 'Resolve GLPI ticket #526'"
}

describe('canUseInlineDraftLaunchPlan', () => {
  it('allows a single-line launch command', () => {
    expect(canUseInlineDraftLaunchPlan(PLAN, 'darwin')).toBe(true)
    expect(canUseInlineDraftLaunchPlan(PLAN, 'win32')).toBe(true)
  })

  it('rejects a multi-line launch command on every platform', () => {
    const plan = { ...PLAN, launchCommand: "claude --prefill 'line one\n\nhttps://x'" }
    expect(canUseInlineDraftLaunchPlan(plan, 'darwin')).toBe(false)
    expect(canUseInlineDraftLaunchPlan(plan, 'win32')).toBe(false)
  })

  it('rejects an oversized command on win32 only', () => {
    const plan = { ...PLAN, launchCommand: `claude --prefill '${'x'.repeat(25_000)}'` }
    expect(canUseInlineDraftLaunchPlan(plan, 'win32')).toBe(false)
    expect(canUseInlineDraftLaunchPlan(plan, 'linux')).toBe(true)
  })
})
