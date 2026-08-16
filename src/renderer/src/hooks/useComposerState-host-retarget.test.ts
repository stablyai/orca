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
    expect(switchSection).toContain('setSelectedProjectHostSetupOverrideId(option.id)')
    expect(switchSection).toContain('preserveStartFrom: true')
    expect(switchSection).toContain('forceResetStartFrom: true')
  })
})
