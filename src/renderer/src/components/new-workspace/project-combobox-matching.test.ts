import { describe, expect, it } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
import { rankProjectOptions } from './project-combobox-matching'

const project = (
  id: string,
  displayName: string,
  hostLabels: string[],
  detail = 'Project'
): NewWorkspaceProjectOption => ({
  kind: 'project',
  id,
  projectId: id,
  displayName,
  badgeColor: '#000',
  detail,
  hostLabels
})

describe('rankProjectOptions host queries', () => {
  const options = [
    project('orca', 'orca', ['This Mac', 'build-box']),
    project('docs', 'docs', ['This Mac'])
  ]

  it('keeps only projects on the named host', () => {
    expect(rankProjectOptions(options, 'build orca', []).map((m) => m.option.id)).toEqual(['orca'])
    expect(rankProjectOptions(options, 'build docs', [])).toEqual([])
  })

  it('keeps a checkout whose detail already names the host', () => {
    const checkout = project('orca-build', 'orca', ['build-box'], 'build-box · ~/src/orca')
    expect(rankProjectOptions([checkout], 'build orca', []).map((m) => m.option.id)).toEqual([
      'orca-build'
    ])
    expect(rankProjectOptions([checkout], 'docs orca', [])).toEqual([])
  })

  it('ranks name hits above host-only hits', () => {
    const ids = rankProjectOptions(
      [...options, project('build', 'build-tools', ['This Mac'])],
      'build',
      []
    ).map((m) => m.option.id)
    expect(ids).toEqual(['build', 'orca'])
  })
})
