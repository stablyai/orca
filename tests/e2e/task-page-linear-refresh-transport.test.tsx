// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  display,
  source
} from '../../src/renderer/src/components/task-page/linear/task-page-linear-refresh-test-fixtures'
import { afterEach, expect, it, vi } from 'vitest'
import type * as RuntimeLinearProjectClient from '@/runtime/runtime-linear-project-client'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { listProjectIssues } from '../../src/main/linear/linear-project-issue-queries'
import { listCustomViewIssues } from '../../src/main/linear/linear-custom-view-queries'
import { linearCollectionCacheKey } from '@/store/slices/linear/linear-cache'
import {
  getLinearSourceScope,
  scopedLinearCacheKey
} from '@/store/slices/linear/linear-slice-scope'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { LinearStateCell } from '../../src/renderer/src/components/task-page/linear/task-page-linear-issue-model'

const provider = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../src/main/linear/client', () => ({
  getClients: () => [
    {
      workspace: { id: 'w', organizationName: 'Workspace' },
      client: { client: { rawRequest: (...args: unknown[]) => provider.load(...args) } }
    }
  ],
  isAuthError: () => false
}))
vi.mock('../../src/main/linear/linear-token-store', () => ({ clearToken: vi.fn() }))
const actual = await vi.importActual<typeof RuntimeLinearProjectClient>(
  '@/runtime/runtime-linear-project-client'
)
let restoreApi = () => {}
afterEach(() => {
  restoreApi()
  restoreApi = () => {}
})

it.each(['project', 'custom-view'] as const)(
  '%s actual provider replacement crosses runtime/main coalescing after StateCell drain',
  async (kind) => {
    const s = store()
    s.setState({ recordFeatureInteraction: vi.fn() })
    const context = source('local')
    const scope = getLinearSourceScope(context)
    const key = scopedLinearCacheKey(
      scope,
      linearCollectionCacheKey(
        'w',
        kind === 'project' ? 'project-issues' : 'custom-view-issues',
        kind === 'project' ? 'p' : 'v',
        36
      )
    )
    const cache = { [key]: { data: { items: [task()] }, fetchedAt: 1 } }
    s.setState(
      kind === 'project'
        ? { linearProjectIssueCache: cache }
        : { linearCustomViewIssueCache: cache }
    )
    reads.project.mockImplementation(actual.linearListProjectIssues)
    reads.view.mockImplementation(actual.linearListCustomViewIssues)
    const previousApi = window.api
    restoreApi = () => Object.assign(window, { api: previousApi })
    const projectIpc = vi.fn(
      (args: { projectId: string; limit?: number; workspaceId: string; force?: boolean }) =>
        listProjectIssues(args.projectId, args.limit, args.workspaceId, args.force)
    )
    const viewIpc = vi.fn(
      (args: { viewId: string; limit?: number; workspaceId: string; force?: boolean }) =>
        listCustomViewIssues(args.viewId, args.limit, args.workspaceId, args.force)
    )
    Object.assign(window, {
      api: { linear: { listProjectIssues: projectIpc, listCustomViewIssues: viewIpc } }
    })
    const packet = (state: string) => {
      const connection = {
        nodes: [{ ...task(state), labels: { nodes: [] } }],
        pageInfo: { hasNextPage: false }
      }
      return {
        data:
          kind === 'project'
            ? { project: { issues: connection } }
            : { customView: { modelName: 'Issue', issues: connection } }
      }
    }
    // Cover retired success/failure and current terminal failure at the actual provider seam.
    for (const outcome of ['success', 'error'] as const) {
      const old = Promise.withResolvers<ReturnType<typeof packet>>()
      const fresh = Promise.withResolvers<ReturnType<typeof packet>>()
      provider.load.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      const hook = display(s, [task()], kind, context)
      await waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1))
      const ipc = kind === 'project' ? projectIpc : viewIpc
      expect(ipc.mock.calls.at(-1)?.[0].force).toBeUndefined()
      // An ordinary duplicate still joins the same renderer/main operation.
      const joined = (
        kind === 'project'
          ? s.getState().listLinearProjectIssues('p', 'w', 36, { sourceContext: context })
          : s.getState().listLinearCustomViewIssues('v', 'w', 36, { sourceContext: context })
      ).acquire()
      expect(provider.load).toHaveBeenCalledTimes(1)
      const pending = Promise.withResolvers<{ ok: boolean }>()
      reads.update.mockReturnValue(pending.promise)
      const cell = render(
        <LinearStateCell
          issue={hook.result.current.displayedLinearIssues[0]}
          sourceContext={context}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(hook.result.current.displayedLinearIssues[0].state.name).toBe('Done')
      await act(async () => {
        pending.resolve({ ok: true })
        await pending.promise
      })
      await waitFor(() => expect(provider.load).toHaveBeenCalledTimes(2))
      expect(ipc.mock.calls.at(-1)?.[0].force).toBe(true)
      expect(pendingLinearIssueWrites.size).toBe(0)
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(packet('In Review'))
        } else {
          old.reject(new Error('retired private provider failure'))
        }
        await old.promise.catch(() => {})
      })
      expect(hook.result.current.displayedLinearIssues[0].state.name).toBe('Done')
      expect(hook.result.current.loading).toBe(true)
      expect(hook.result.current.error).toBeNull()
      await act(async () => {
        if (outcome === 'success') {
          fresh.resolve(packet('External'))
        } else {
          fresh.reject(new Error('current private provider failure'))
        }
        await fresh.promise.catch(() => {})
      })
      await waitFor(() =>
        expect(hook.result.current.displayedLinearIssues[0].state.name).toBe(
          outcome === 'success' ? 'External' : 'Done'
        )
      )
      expect(hook.result.current.loading).toBe(false)
      expect(hook.result.current.error).toBe(
        outcome === 'success' ? null : 'Unable to load Linear issues. Try again.'
      )
      expect(provider.load).toHaveBeenCalledTimes(2)
      if (outcome === 'error') {
        const forced = Promise.withResolvers<ReturnType<typeof packet>>()
        provider.load.mockReturnValueOnce(forced.promise)
        let lease!: typeof joined
        act(() => {
          lease = (
            kind === 'project'
              ? s
                  .getState()
                  .listLinearProjectIssues('p', 'w', 36, { sourceContext: context, force: true })
              : s
                  .getState()
                  .listLinearCustomViewIssues('v', 'w', 36, { sourceContext: context, force: true })
          ).acquire()
        })
        await waitFor(() => expect(provider.load).toHaveBeenCalledTimes(3))
        await act(async () => {
          forced.resolve(packet('External'))
          await forced.promise
        })
        await waitFor(() =>
          expect(hook.result.current.displayedLinearIssues[0].state.name).toBe('External')
        )
        expect(hook.result.current.error).toBeNull()
        lease.release()
      }
      joined.release()
      hook.unmount()
      cell.unmount()
      // Next ordinary mount must load again; leave only own-query warm rows.
      s.setState(
        kind === 'project'
          ? { linearProjectIssueCache: cache }
          : { linearCustomViewIssueCache: cache }
      )
    }
    const old = Promise.withResolvers<ReturnType<typeof packet>>()
    provider.load.mockReset().mockReturnValue(old.promise)
    const hook = display(s, [task()], kind, context)
    await waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1))
    const pending = Promise.withResolvers<{ ok: boolean }>()
    reads.update.mockReturnValue(pending.promise)
    const cell = render(
      <LinearStateCell
        issue={hook.result.current.displayedLinearIssues[0]}
        sourceContext={context}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Change Linear state from/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    hook.unmount()
    await act(async () => {
      pending.resolve({ ok: true })
      old.resolve(packet('In Review'))
      await old.promise
    })
    expect(provider.load).toHaveBeenCalledTimes(1)
    expect(pendingLinearIssueWrites.size).toBe(0)
    cell.unmount()
  }
)
