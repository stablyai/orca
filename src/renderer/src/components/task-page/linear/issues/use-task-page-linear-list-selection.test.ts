// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { expect, it } from 'vitest'
import type { LinearTeam } from '../../../../../../shared/linear/workspace-types'
import type { TaskPageProviderMetadataModel } from '../../use-task-page-provider-metadata'
import { useTaskPageLinearListSelectionPrelude } from './use-task-page-linear-list-selection'

const backend: LinearTeam = { id: 'backend', name: 'Backend', key: 'B' }
const mobile: LinearTeam = { id: 'mobile', name: 'Mobile', key: 'M' }
const emptyCollection = { items: [], errors: undefined, hasMore: false }
const settings = { defaultLinearTeamSelection: null }
const linearStatus = { credentialError: null }

const stableIssues: never[] = []

function preludeModel(
  availableTeams: LinearTeam[],
  linearIssues: never[]
): TaskPageProviderMetadataModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prelude reads only these fields; the full page model is not needed here.
  return {
    settings,
    linearStatus,
    linearIssues,
    linearIssueLimit: 50,
    linearIssuePage: 0,
    linearIssueLoadingTargetPage: null,
    linearIssuesHasMore: false,
    linearLoading: true,
    linearError: null,
    appliedLinearSearch: '',
    selectedLinearProject: null,
    linearProjectTab: 'issues',
    linearProjectIssuesResult: emptyCollection,
    selectedLinearCustomView: null,
    linearCustomViewIssuesResult: emptyCollection,
    availableTeams
  } as unknown as TaskPageProviderMetadataModel
}

it('reconciles the team selection in the commit that changes the team ids', () => {
  const committed: string[][] = []
  const { rerender } = renderHook(
    ({ availableTeams }: { availableTeams: LinearTeam[] }) => {
      const model = useTaskPageLinearListSelectionPrelude(
        preludeModel(availableTeams, stableIssues)
      )
      useLayoutEffect(() => {
        committed.push([...model.linearTeamSelection])
      })
      return model
    },
    { initialProps: { availableTeams: [mobile] } }
  )
  rerender({ availableTeams: [backend, mobile] })

  // A selection lagging the options let the filter prune drop the facets of teams not yet reselected.
  expect(committed).toEqual([['mobile'], ['backend', 'mobile']])
})

it('settles when the issue list is rebuilt every render while teams are loaded', () => {
  // A fresh list each render, like the committed-state seed while an issue target change is pending.
  let renders = 0
  const { result } = renderHook(() => {
    // Fail with an assertion instead of an effect loop exhausting the worker's heap.
    renders += 1
    expect(renders).toBeLessThan(20)
    return useTaskPageLinearListSelectionPrelude(preludeModel([backend, mobile], []))
  })
  expect([...result.current.linearTeamSelection]).toEqual(['backend', 'mobile'])
})
