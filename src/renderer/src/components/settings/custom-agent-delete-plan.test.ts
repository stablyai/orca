import { describe, expect, it } from 'vitest'
import { recommendDeleteDefault, summarizeDeleteReferences } from './custom-agent-delete-plan'

const noneDisabled = new Set<never>()

describe('recommendDeleteDefault', () => {
  it('recommends base when the base has a configured executable and is enabled', () => {
    const rec = recommendDeleteDefault({
      base: 'claude',
      detectedIds: new Set(),
      agentCmdOverrides: { claude: '/opt/claude' },
      disabledAgents: noneDisabled
    })
    expect(rec).toEqual({ recommended: 'base', baseLaunchable: true, detectionKnown: true })
  })

  it('recommends base when the base is stock-detected', () => {
    const rec = recommendDeleteDefault({
      base: 'claude',
      detectedIds: new Set(['claude']),
      agentCmdOverrides: {},
      disabledAgents: noneDisabled
    })
    expect(rec.recommended).toBe('base')
    expect(rec.baseLaunchable).toBe(true)
  })

  it('recommends Auto for a concrete missing stock base', () => {
    const rec = recommendDeleteDefault({
      base: 'claude',
      detectedIds: new Set(['codex']),
      agentCmdOverrides: {},
      disabledAgents: noneDisabled
    })
    expect(rec).toEqual({ recommended: 'auto', baseLaunchable: false, detectionKnown: true })
  })

  it('recommends Auto with unknown detection while probing is in flight', () => {
    const rec = recommendDeleteDefault({
      base: 'claude',
      detectedIds: null,
      agentCmdOverrides: {},
      disabledAgents: noneDisabled
    })
    expect(rec).toEqual({ recommended: 'auto', baseLaunchable: false, detectionKnown: false })
  })

  it('does not recommend base when the base is disabled, even if detected', () => {
    const rec = recommendDeleteDefault({
      base: 'claude',
      detectedIds: new Set(['claude']),
      agentCmdOverrides: { claude: '/opt/claude' },
      disabledAgents: new Set(['claude'])
    })
    expect(rec.recommended).toBe('auto')
    expect(rec.baseLaunchable).toBe(false)
  })
})

describe('summarizeDeleteReferences', () => {
  it('sums readable non-default counts and excludes the default owner', () => {
    const total = summarizeDeleteReferences([
      { owner: 'default', count: 1 },
      { owner: 'quick-command', count: 2 },
      { owner: 'automation', count: 3 }
    ])
    expect(total).toEqual({ total: 5, unreadable: false })
  })

  it('flags an unreadable owner store and treats the total as a floor', () => {
    const total = summarizeDeleteReferences([
      { owner: 'session', count: 4 },
      { owner: 'workspace', count: -1 }
    ])
    expect(total).toEqual({ total: 4, unreadable: true })
  })
})
