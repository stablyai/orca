import { describe, expect, it } from 'vitest'
import { herdrSessionNameForProject, herdrSplitDirection } from './herdr-session-identity'

describe('Herdr session identity', () => {
  it('uses the persisted project session name when linked explicitly', () => {
    expect(
      herdrSessionNameForProject({ id: 'Project 1', herdrSessionName: ' shared-session ' })
    ).toBe('shared-session')
  })

  it('uses the shared Orca default when no per-project override is set', () => {
    expect(herdrSessionNameForProject({ id: 'Project 1' }, 'orca')).toBe('orca')
    expect(herdrSessionNameForProject({ id: 'Project 1' }, ' shared-session ')).toBe(
      'shared-session'
    )
  })

  it('prefers the per-project override over the shared default', () => {
    expect(
      herdrSessionNameForProject({ id: 'Project 1', herdrSessionName: 'custom' }, 'orca')
    ).toBe('custom')
  })

  it('derives a stable stock Herdr session name when no name is configured', () => {
    const name = herdrSessionNameForProject({ id: 'Project 1' })
    expect(name).toMatch(/^orca-[a-f0-9]{8}$/)
    expect(name.length).toBeLessThanOrEqual(13)
    expect(herdrSessionNameForProject({ id: `${'project-'.repeat(20)}a` })).not.toBe(
      herdrSessionNameForProject({ id: `${'project-'.repeat(20)}b` })
    )
  })

  it('ignores a blank shared default so per-project derivation still applies', () => {
    expect(herdrSessionNameForProject({ id: 'Project 1' }, '   ')).toMatch(/^orca-[a-f0-9]{8}$/)
  })

  it('translates Orca split axes exactly', () => {
    expect(herdrSplitDirection('vertical')).toBe('right')
    expect(herdrSplitDirection('horizontal')).toBe('down')
  })
})
