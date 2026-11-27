import { expect, it, vi } from 'vitest'
import type { WebRuntimeBrowserCreationFailureInfo } from './web-runtime-browser-creation-context'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const { finishWebRuntimeBrowserCreationFailure } =
  await import('./web-runtime-browser-creation-failure')

it("reports the host's refusal and its stage, not the cleanup error that followed", () => {
  const reported: WebRuntimeBrowserCreationFailureInfo[] = []
  const context = {
    args: {
      worktreeId: 'folder:bot',
      failureLogMode: 'operation-only',
      onFailure: (info: WebRuntimeBrowserCreationFailureInfo) => reported.push(info)
    },
    intentOwner: { environmentId: 'env-1', pairingRevision: 1 },
    guardedPageId: 'page-1',
    shouldFocusOnCreate: false,
    createAttempted: true,
    createdPageId: null
  }
  const hostRefusal = Object.assign(new Error('Browser profile work was not found'), {
    code: 'invalid_argument'
  })
  const cleanupFailure = Object.assign(new Error('gone'), { code: 'browser_tab_not_found' })

  expect(() =>
    finishWebRuntimeBrowserCreationFailure(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failure path reads only the fields set above.
      context as never,
      {
        cleanupPageId: 'page-1',
        createOutcomeUnknown: false,
        ownsClientGroupCleanup: false,
        recoveryError: cleanupFailure
      },
      hostRefusal
    )
  ).toThrow()
  expect(reported).toEqual([{ stage: 'create', code: 'invalid_argument' }])
})
