import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { retargetGitHubPrStartPointSelection } from './useComposerState'

const HOOK_SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('useComposerState host retarget', () => {
  it('re-resolves a seeded PR after switching its run host', () => {
    const item = {
      id: 'pr-42',
      type: 'pr' as const,
      number: 42,
      title: 'Fix PR workspace creation',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/42',
      labels: [],
      updatedAt: '2026-08-04T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-local'
    }
    const selection = {
      repoId: 'repo-local',
      item,
      resolved: {
        baseBranch: 'local-head',
        compareBaseRef: 'origin/main'
      }
    }

    expect(retargetGitHubPrStartPointSelection(selection, 'repo-ssh')).toEqual({
      repoId: 'repo-ssh',
      item
    })
  })

  it('retains an explicit host setup when duplicate repos share an id', () => {
    const targetSection = sourceBetween(
      HOOK_SOURCE,
      'const selectedWorkspaceTarget = useMemo',
      'const selectedRepo ='
    )
    expect(targetSection).toContain('projectHostSetupId: selectedProjectHostSetupOverrideId')

    const switchSection = sourceBetween(
      HOOK_SOURCE,
      'const handleProjectHostSetupChange',
      'const handleProjectChange'
    )
    expect(switchSection).toContain('setSelectedProjectHostSetupOverrideId(target.id)')
    expect(switchSection).toContain('preserveStartFrom: true')
    expect(switchSection).toContain('forceResetStartFrom: true')
  })

  it('resolves a just-created setup through the option builder, not the raw store record', () => {
    const switchSection = sourceBetween(
      HOOK_SOURCE,
      'const handleProjectHostSetupChange',
      'const handleProjectChange'
    )
    // Reading projectHostSetups directly skips repo eligibility, ephemeral-VM and
    // runtime-owned host exclusion, and the one-setup-per-host dedupe that decides
    // which setup creation resolves to — so a set location could retarget the
    // composer at a different location than the one just chosen (#14868/#14912).
    expect(switchSection).not.toContain('.projectHostSetups.find(')
    expect(switchSection).toContain('buildProjectHostSetupOptions({')
    expect(switchSection).toContain("candidate.kind === 'ready'")
  })
})
