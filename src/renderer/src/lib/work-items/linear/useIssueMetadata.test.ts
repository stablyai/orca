// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { LinearMember } from '../../../../../shared/linear/workspace-types'
import { useTeamsMembers } from './useIssueMetadata'

vi.mock('@/runtime/linear/runtime-linear-project-client', () => ({
  linearTeamMembers: async (_settings: unknown, teamId: string) => [
    { id: `${teamId}-member`, displayName: teamId }
  ]
}))

it('never reports the previous team set as loaded data for a new team set', async () => {
  const seen: { teamIds: string[]; data: LinearMember[]; loading: boolean }[] = []
  const { result, rerender } = renderHook(
    ({ teamIds }: { teamIds: string[] }) => {
      const state = useTeamsMembers(teamIds, undefined, 'ws-1')
      seen.push({ teamIds, data: state.data, loading: state.loading })
      return state
    },
    { initialProps: { teamIds: ['mobile'] } }
  )
  await waitFor(() =>
    expect(result.current.data).toEqual([{ id: 'mobile-member', displayName: 'mobile' }])
  )

  rerender({ teamIds: ['backend'] })
  await waitFor(() =>
    expect(result.current.data).toEqual([{ id: 'backend-member', displayName: 'backend' }])
  )

  // The filter prune treats loaded data as the current team set's; stale members would keep the old team's facets.
  const staleLoaded = seen.filter(
    (render) =>
      render.teamIds[0] === 'backend' &&
      !render.loading &&
      render.data.some((member) => member.id === 'mobile-member')
  )
  expect(staleLoaded).toEqual([])
})
