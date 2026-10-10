import { describe, expect, it } from 'vitest'
import {
  defaultSelectedSkillProviders,
  groupSkillInstallProviders,
  skillProviderDirectoryLabel,
  toggledSkillProviderSelection
} from './skill-install-provider-groups'

describe('groupSkillInstallProviders', () => {
  // Why: an agent that reads .agents/skills is reached by every install, so
  // offering a checkbox for it would imply a choice that does not exist.
  it('separates agents that read the canonical root from agents with their own', () => {
    const workspace = groupSkillInstallProviders('workspace')
    const global = groupSkillInstallProviders('global')
    expect(workspace.canonical.map((provider) => provider.id)).toContain('codex')
    expect(global.canonical.map((provider) => provider.id)).toContain('codex')
    expect(workspace.selectable.map((choice) => choice.provider.id)).toContain('claude')
    expect(workspace.selectable.map((choice) => choice.provider.id)).not.toContain('codex')
    expect(global.selectable.map((choice) => choice.provider.id)).not.toContain('codex')
  })

  it('moves an agent between the groups when the scope changes', () => {
    expect(groupSkillInstallProviders('workspace').canonical.map((p) => p.id)).toContain('cursor')
    expect(groupSkillInstallProviders('global').selectable.map((c) => c.provider.id)).toContain(
      'cursor'
    )
  })

  it('labels a directory relative to the scope it is shown under', () => {
    expect(skillProviderDirectoryLabel(['.claude', 'skills'], 'workspace')).toBe('.claude/skills')
    expect(skillProviderDirectoryLabel(['.claude', 'skills'], 'global')).toBe('~/.claude/skills')
  })
})

describe('defaultSelectedSkillProviders', () => {
  it('starts with the agents the machine actually has', () => {
    const selected = defaultSelectedSkillProviders(['claude', 'codex', 'unrelated-tool'])
    expect([...selected]).toEqual(['codex', 'claude'])
  })

  // Why: a runtime Orca cannot probe from here must not read as "no agents
  // installed" — that would quietly install nothing.
  it('falls back to every agent when detection is unavailable', () => {
    const selected = defaultSelectedSkillProviders(null)
    expect(selected.has('claude')).toBe(true)
    expect(selected.has('aug')).toBe(true)
  })

  it('selects nothing extra when the machine has no known agent', () => {
    expect([...defaultSelectedSkillProviders([])]).toEqual([])
  })

  it('adds and removes one agent at a time', () => {
    const withoutClaude = toggledSkillProviderSelection(
      defaultSelectedSkillProviders(null),
      'claude',
      false
    )
    expect(withoutClaude.has('claude')).toBe(false)
    expect(withoutClaude.has('codex')).toBe(true)
    expect(toggledSkillProviderSelection(withoutClaude, 'claude', true).has('claude')).toBe(true)
  })
})
