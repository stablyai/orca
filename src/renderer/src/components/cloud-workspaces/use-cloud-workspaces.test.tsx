// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudWorkspace,
  CloudWorkspaceListQuery
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { workspace } from './cloud-workspaces.test-fixture'
import { useCloudWorkspaces } from './use-cloud-workspaces'

type ListResult = { ok: true; value: CloudWorkspace[] }
let pending: ((result: ListResult) => void)[] = []
const QUERY: CloudWorkspaceListQuery = { scope: 'mine', archived: 'exclude' }

beforeEach(() => {
  pending = []
  vi.stubGlobal('api', {
    cloudWorkspaces: {
      available: () => Promise.resolve(true),
      list: vi.fn(
        () =>
          new Promise<ListResult>((resolve) => {
            pending.push(resolve)
          })
      )
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const teamA = [workspace({ id: 'ws-a' })]
const teamB = [workspace({ id: 'ws-b' })]

function render() {
  return renderHook(({ account }) => useCloudWorkspaces(QUERY, true, account), {
    initialProps: { account: 'user-1:team-a' }
  })
}

describe('useCloudWorkspaces on a team switch', () => {
  it('hides the previous team list and reads the new team at once', async () => {
    const { result, rerender } = render()
    await act(async () => {})
    await act(async () => pending[0]({ ok: true, value: teamA }))
    expect(result.current.state).toMatchObject({ status: 'ready', workspaces: teamA })

    rerender({ account: 'user-1:team-b' })
    // Not the old team's rows dimmed as "stale": nothing of team A is shown.
    expect(result.current.state).toEqual({ status: 'loading' })
    expect(result.current.stale).toBe(false)
    await act(async () => {})
    expect(pending).toHaveLength(2)

    await act(async () => pending[1]({ ok: true, value: teamB }))
    expect(result.current.state).toMatchObject({ status: 'ready', workspaces: teamB })
  })

  it('drops a list read for the previous team that lands after the switch', async () => {
    const { result, rerender } = render()
    await act(async () => {})
    expect(pending).toHaveLength(1)

    rerender({ account: 'user-1:team-b' })
    await act(async () => {})
    await act(async () => pending[0]({ ok: true, value: teamA }))
    expect(result.current.state).toEqual({ status: 'loading' })

    await act(async () => pending[1]({ ok: true, value: teamB }))
    expect(result.current.state).toMatchObject({ status: 'ready', workspaces: teamB })
  })
})
