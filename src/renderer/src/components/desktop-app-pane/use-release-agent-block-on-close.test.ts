import { describe, expect, it } from 'vitest'
import { shouldReleaseAgentBlock } from './use-release-agent-block-on-close'

const remembered: Record<string, number> = { 'tab-a': 42, 'tab-b': 42, 'tab-c': 7 }
const rememberedPid = (id: string): number | null => remembered[id] ?? null

describe('shouldReleaseAgentBlock', () => {
  it('keeps the block while the tab is still open (remount)', () => {
    const tabs = [{ id: 'tab-a', contentType: 'desktop-app' as const }]
    expect(shouldReleaseAgentBlock('tab-a', 42, tabs, rememberedPid)).toBe(false)
  })

  it('releases it once the last tab showing the app closes', () => {
    const tabs = [{ id: 'tab-c', contentType: 'desktop-app' as const }]
    expect(shouldReleaseAgentBlock('tab-a', 42, tabs, rememberedPid)).toBe(true)
  })

  it('releases it when the open tab switched to a window of another app', () => {
    const tabs = [{ id: 'tab-c', contentType: 'desktop-app' as const }]
    expect(shouldReleaseAgentBlock('tab-c', 42, tabs, rememberedPid)).toBe(true)
  })

  it('keeps it when the open tab has no remembered window to compare', () => {
    const tabs = [{ id: 'tab-x', contentType: 'desktop-app' as const }]
    expect(shouldReleaseAgentBlock('tab-x', 42, tabs, rememberedPid)).toBe(false)
  })

  it('keeps it while another Desktop App tab still shows the app', () => {
    const tabs = [{ id: 'tab-b', contentType: 'desktop-app' as const }]
    expect(shouldReleaseAgentBlock('tab-a', 42, tabs, rememberedPid)).toBe(false)
  })
})
