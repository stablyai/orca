import { describe, expect, it } from 'vitest'
import {
  taskPageDataRequestsBuiltin,
  taskPageOpenPrefersPluginSource
} from './plugin-task-page-source'

describe('plugin task page source routing', () => {
  it('treats a bare open as eligible for the saved plugin source', () => {
    expect(taskPageDataRequestsBuiltin({})).toBe(false)
    expect(taskPageOpenPrefersPluginSource({}, 'orca-samples.roadmap/plans')).toBe(true)
    expect(taskPageOpenPrefersPluginSource({}, null)).toBe(false)
    expect(taskPageOpenPrefersPluginSource({}, 'not a key')).toBe(false)
  })

  it('lets a built-in source, repo scope, or item deep link win over the saved plugin source', () => {
    expect(
      taskPageOpenPrefersPluginSource({ taskSource: 'jira' }, 'orca-samples.roadmap/plans')
    ).toBe(false)
    expect(
      taskPageOpenPrefersPluginSource({ preselectedRepoId: 'repo-1' }, 'orca-samples.roadmap/plans')
    ).toBe(false)
  })

  it('always prefers an explicitly requested plugin source', () => {
    expect(
      taskPageOpenPrefersPluginSource(
        { pluginTaskSource: { pluginKey: 'orca-samples.roadmap', sourceId: 'plans' } },
        null
      )
    ).toBe(true)
  })
})
