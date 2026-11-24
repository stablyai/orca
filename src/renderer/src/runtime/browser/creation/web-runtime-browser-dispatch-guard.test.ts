import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: [] as string[], discarded: 0, admit: true }))

vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true
}))
vi.mock('./testing/web-runtime-browser-creation-e2e-fault', () => ({
  pauseAfterE2eWebRuntimeBrowserCreate: async () => {},
  pauseDuringE2eWebRuntimeBrowserClientHostPreparation: async () => {}
}))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: async () => {}
}))
vi.mock('./web-runtime-browser-tab-staging', () => ({
  isStagedWebRuntimeBrowserTabLive: () => true,
  resolveStagedWebRuntimeBrowserTabGroupId: () => undefined,
  StagedWebRuntimeBrowserTabCancelledError: class extends Error {}
}))
vi.mock('@/runtime/browser/creation/staged-browser-frame-handover', () => ({
  forgetStagedBrowserTabHandover: () => {},
  wasStagedBrowserTabHandedToFrames: () => false
}))
vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: () => true
}))
vi.mock('./web-runtime-browser-creation-context', () => ({
  createWebRuntimeBrowserCreationContext: (args: unknown, environmentId: string) => ({
    args,
    environmentId,
    intentOwner: { pairingRevision: 1 },
    provisionalPageId: 'provisional',
    guardedPageId: 'provisional',
    hostSupportsKnownPageId: true,
    shouldFocusOnCreate: false,
    staged: { workspaceId: 'staged' },
    createAttempted: false,
    createdPageId: null,
    unsubscribeFocusGuard: () => {},
    callEnvironment: async ({ method }: { method: string }) => {
      h.rpc.push(method)
      return { ok: true, result: { browserPageId: 'remote-1' } }
    }
  }),
  stageWebRuntimeBrowserCreation: () => {},
  restageWebRuntimeBrowserCreation: () => {},
  completeWebRuntimeBrowserCreation: () => {},
  rehomeWebRuntimeBrowserCreation: () => {},
  resolveWebRuntimeBrowserClientTargetGroupId: () => undefined
}))
vi.mock('./web-runtime-browser-creation-failure', () => ({
  prepareWebRuntimeBrowserCreationFailure: (context: { createdPageId: string | null }) => {
    h.discarded += 1
    return { cleanupPageId: context.createdPageId, recoveryError: null }
  },
  finishWebRuntimeBrowserCreationFailure: () => false
}))
vi.mock('../../rpc/calls/runtime-rpc-result', () => ({
  unwrapRuntimeRpcResult: (response: { result: unknown }) => response.result
}))

import { createWebRuntimeSessionBrowserTabOnHost } from './web-runtime-browser-creation'

function holdPlacement(): { release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  Object.assign(globalThis, {
    window: {
      api: {
        runtimeEnvironments: {
          prepareBrowserClientHostPlacement: async () => {
            await held
            return { kind: 'server' }
          }
        }
      }
    }
  })
  return { release }
}

beforeEach(() => {
  h.rpc = []
  h.discarded = 0
  h.admit = true
})

// Why: the first case imports the remote browser-creation graph cold, which can pass 5s on a busy host.
describe('remote browser creation for a link', { timeout: 60_000 }, () => {
  it('sends no tab create when admission is lost while preparation is pending', async () => {
    const placement = holdPlacement()
    const creating = createWebRuntimeSessionBrowserTabOnHost(
      {
        worktreeId: 'wt',
        environmentId: 'A',
        url: 'https://x.test/',
        admitDispatch: () => h.admit
      },
      'A'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.admit = false
    placement.release()
    expect(await creating).toBe(false)
    expect(h.rpc).toEqual([])
    expect(h.discarded).toBe(1)
  })

  it('checks admission on the path with no placement probe too', async () => {
    h.admit = false
    expect(
      await createWebRuntimeSessionBrowserTabOnHost(
        {
          worktreeId: 'wt',
          environmentId: 'A',
          url: 'https://x.test/',
          placementPreference: 'server',
          admitDispatch: () => h.admit
        },
        'A'
      )
    ).toBe(false)
    expect(h.rpc).toEqual([])
  })

  it('creates the tab when admission still holds', async () => {
    const placement = holdPlacement()
    const creating = createWebRuntimeSessionBrowserTabOnHost(
      {
        worktreeId: 'wt',
        environmentId: 'A',
        url: 'https://x.test/',
        admitDispatch: () => h.admit
      },
      'A'
    )
    placement.release()
    expect(await creating).toBe(true)
    expect(h.rpc).toEqual(['browser.tabCreate'])
  })
})
