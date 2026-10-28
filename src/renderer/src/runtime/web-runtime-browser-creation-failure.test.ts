import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import type { WebRuntimeBrowserCreationContext } from './web-runtime-browser-creation-context'
import { prepareWebRuntimeBrowserCreationFailure } from './web-runtime-browser-creation-failure'

vi.mock('../store', () => ({ useAppStore: { getState: vi.fn(), setState: vi.fn() } }))

function failedCreateContext(): WebRuntimeBrowserCreationContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failure path reads only worktreeId and the group fields, which are absent here.
    args: { worktreeId: 'repo::/w' } as never,
    environmentId: 'env-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prepare step never reads the intent owner.
    intentOwner: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prepare step never calls the environment.
    callEnvironment: vi.fn() as never,
    shouldFocusOnCreate: false,
    shouldSelectWorktree: false,
    provisionalPageId: 'provisional-page',
    hostSupportsKnownPageId: true,
    expectsClientHosting: false,
    unsubscribeFocusGuard: vi.fn(),
    guardedPageId: 'provisional-page',
    createdPageId: null,
    createAttempted: true,
    staged: null
  }
}

function prepare(error: unknown): { cleanupPageId: string | null; createOutcomeUnknown: boolean } {
  const { cleanupPageId, createOutcomeUnknown } = prepareWebRuntimeBrowserCreationFailure(
    failedCreateContext(),
    error
  )
  return { cleanupPageId, createOutcomeUnknown }
}

// Pins which create failures prove no page exists (round-2 S5), so a dropped code is deliberate.
describe('prepareWebRuntimeBrowserCreationFailure definitive codes', () => {
  it.each([
    'browser_error',
    'capability_unsupported',
    'invalid_argument',
    'invalid_params',
    'method_not_found',
    'runtime_rpc_queue_overloaded',
    'selector_ambiguous',
    'selector_not_found',
    'unauthorized'
  ])('skips the provisional-page cleanup after %s', (code) => {
    expect(prepare(new RemoteRuntimeClientError(code, 'failed'))).toEqual({
      cleanupPageId: null,
      createOutcomeUnknown: false
    })
  })

  it.each([
    'runtime_manually_disconnected',
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'remote_runtime_busy',
    'runtime_error'
  ])('cleans up the provisional page after %s', (code) => {
    expect(prepare(new RemoteRuntimeClientError(code, 'failed'))).toEqual({
      cleanupPageId: 'provisional-page',
      createOutcomeUnknown: false
    })
  })

  it('reads a definitive code from a code-stripped message token', () => {
    expect(
      prepare(new Error("Error invoking remote method 'x': Error: failed: method_not_found"))
    ).toEqual({
      cleanupPageId: null,
      createOutcomeUnknown: false
    })
  })
})
