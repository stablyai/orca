// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  api,
  mocks,
  installAutomationsPageHarness,
  renderPage,
  settleHostQueries,
  scopedList,
  runtimeHost,
  addRuntimeProject,
  RUNTIME_REPO_ID
} from './automations-page-test-harness'
import { makeAutomation, makeStoreState } from './automations-page-fixtures'
import { listedRows } from './automations-page-listed-items'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'

describe('automation retarget setup consent', () => {
  installAutomationsPageHarness()

  it.each([
    [false, 'skip'],
    [true, 'skip'],
    [false, 'run']
  ] as const)(
    'persists resolved consent on retarget (move=%s, consent=%s)',
    async (move, consent) => {
      const saved = makeAutomation({ setupDecision: 'run' })
      api.automations.list.mockResolvedValue([saved])
      scopedList([saved])
      vi.mocked(ensureHooksConfirmed).mockResolvedValue(consent)
      mocks.state.fetchWorktrees = async () => {}
      const nextRepo = { ...makeStoreState().state.repos[0]!, id: 'repo-next', path: '/next' }
      if (move) {
        runtimeHost([], [])
        addRuntimeProject()
        const previous = mocks.callRuntimeRpc.getMockImplementation()
        mocks.callRuntimeRpc.mockImplementation(
          async (target: unknown, method: string, params: unknown, options: unknown) => {
            if (method === 'automation.create') {
              return { automation: { ...saved, id: 'replacement' } }
            }
            return previous?.(target, method, params, options)
          }
        )
      } else {
        mocks.state.repos = [...mocks.state.repos, nextRepo]
        mocks.repoMap.set(nextRepo.id, nextRepo)
        mocks.state.projectHostSetups = [
          ...mocks.state.projectHostSetups,
          {
            ...mocks.state.projectHostSetups[0]!,
            id: 'next-setup',
            projectId: 'next-project',
            repoId: nextRepo.id,
            path: nextRepo.path
          }
        ]
      }
      await renderPage()
      await settleHostQueries()
      const row = listedRows().find((entry) => entry.automation.id === saved.id)
      if (!row) {
        throw new Error('Missing automation')
      }
      await act(async () => {
        mocks.listPanel?.openEditDialog(row)
      })
      if (move) {
        const entry = mocks.editorDialog?.editDestination?.entries.find(
          (entry) => entry.stableRef.authority.kind === 'runtime'
        )
        if (!entry) {
          throw new Error('Missing runtime destination')
        }
        await act(async () => {
          mocks.editorDialog?.editDestination?.onSelect(entry.stableKey)
        })
      }
      await act(async () => {
        mocks.editorDialog?.onProjectChange(move ? RUNTIME_REPO_ID : nextRepo.id)
      })
      await act(async () => {
        await mocks.editorDialog?.onSave()
      })
      expect(ensureHooksConfirmed).toHaveBeenCalledOnce()
      expect(mocks.toastError).not.toHaveBeenCalled()
      if (move) {
        const create = mocks.callRuntimeRpc.mock.calls.find(
          ([, method]) => method === 'automation.create'
        )
        expect(create?.[2]).toMatchObject({ setupDecision: consent })
        expect(api.automations.delete).toHaveBeenCalledWith(
          expect.objectContaining({ id: saved.id, expectedOwner: { selector: { kind: 'self' } } })
        )
      } else {
        expect(api.automations.update).toHaveBeenCalledWith(
          expect.objectContaining({
            id: saved.id,
            expectedOwner: { selector: { kind: 'self' } },
            updates: expect.objectContaining(
              consent === 'skip' ? { setupDecision: 'skip' } : { repo: 'id:repo-next' }
            )
          })
        )
        if (consent === 'run') {
          expect(
            api.automations.update.mock.calls[0]?.[0].updates.setupDecision ?? saved.setupDecision
          ).toBe('run')
        }
        expect(api.automations.create).not.toHaveBeenCalled()
      }
    }
  )
})
