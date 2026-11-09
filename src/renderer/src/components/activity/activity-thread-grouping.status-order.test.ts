import { describe, expect, it } from 'vitest'

import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import { getProjectGroupingIndexFromState } from '../../store/projects/project-host-setup-selector'
import {
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups
} from './activity-thread-grouping'

import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeWorktree, makeTab } from './ActivityPrototypePage-test-fixtures'

{
  function makeThread(paneKey: string, paneTitle: string): AgentPaneThread {
    return {
      paneKey,
      tab: makeTab(),
      worktree: makeWorktree(),
      repo: null,
      currentAgentState: null,
      currentAgentEntry: null,
      latestEvent: null,
      latestTimestamp: 1_000,
      agentType: 'claude',
      unread: false,
      paneTitle,
      responsePreview: 'x'.repeat(2_000),
      events: []
    }
  }

  describe('activity thread search', () => {
    it('searches rebuilt thread data when the pane key stays the same', () => {
      const first = makeThread('tab-1:leaf-1', 'First title')
      const rebuilt = makeThread('tab-1:leaf-1', 'Second title')
      expect(activityThreadMatchesSearchQuery({ thread: first, searchQuery: 'first' })).toBe(true)
      expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'second' })).toBe(
        true
      )
      expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'first' })).toBe(
        false
      )
    })
  })
}

describe('activity project grouping', () => {
  it.each(['repository', 'host', 'folder'] as const)(
    'groups threads by the same project membership as the sidebar in %s mode',
    (projectGroupingMode) => {
      const upstream = { owner: 'org', repo: 'app' }
      const repos: Repo[] = [
        { ...makeRepo(), id: 'first', path: '/app', upstream },
        { ...makeRepo(), id: 'second', path: '/copy', upstream },
        {
          ...makeRepo(),
          id: 'remote',
          path: '/remote',
          upstream,
          executionHostId: 'runtime:remote'
        }
      ]
      const threads: AgentPaneThread[] = repos.map((repo) => ({
        paneKey: repo.id,
        tab: makeTab(),
        worktree: { ...makeWorktree(), repoId: repo.id, hostId: repo.executionHostId ?? 'local' },
        repo,
        currentAgentState: null,
        currentAgentEntry: null,
        latestEvent: null,
        latestTimestamp: 1_000,
        agentType: 'claude',
        unread: false,
        paneTitle: repo.id,
        responsePreview: '',
        events: []
      }))
      const index = getProjectGroupingIndexFromState({
        repos,
        settings: { ...getDefaultSettings('/tmp'), projectGroupingMode }
      })
      const groups = buildActivityThreadGroups(threads, 'project', undefined, repos, index)
      expect(groups).toHaveLength(
        projectGroupingMode === 'repository' ? 1 : projectGroupingMode === 'host' ? 2 : 3
      )
      expect(groups.flatMap((group) => group.threads.map((thread) => thread.paneKey))).toEqual([
        'first',
        'second',
        'remote'
      ])
    }
  )
})
