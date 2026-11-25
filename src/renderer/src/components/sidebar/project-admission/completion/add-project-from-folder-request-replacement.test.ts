// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import AddProjectFromFolderDialog from '../dialog/AddProjectFromFolderDialog'
import {
  checkout,
  createSetup,
  deferred,
  repo,
  type Harness
} from './selected-checkout-handoff.test-fixture'

const harness = vi.hoisted((): Harness => ({
  state: null,
  activate: vi.fn(),
  persist: vi.fn(),
  subscribe: vi.fn(),
  error: vi.fn(),
  onboarding: vi.fn(),
  add: vi.fn(),
  warning: vi.fn(),
  findProjectProfiles: vi.fn()
}))
vi.mock('@/store/index', async () => {
  const { useSyncExternalStore } = await import('react')
  // Mounted components subscribe like the app store's hook; handoff code reads getState.
  const useAppStore = <T>(selector: (state: AppState) => T): T =>
    useSyncExternalStore(
      (listener) => harness.subscribe(listener),
      () => selector(harness.state!)
    )
  return {
    useAppStore: Object.assign(useAppStore, {
      getState: () => harness.state!,
      subscribe: (listener: () => void) => harness.subscribe(listener)
    })
  }
})

vi.mock('sonner', () => ({
  toast: { error: harness.error, warning: harness.warning, success: vi.fn(), info: vi.fn() }
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: harness.activate
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: harness.onboarding
}))
vi.mock('@/store/projects/project-host-routing', () => ({
  getProjectSetupRuntimeTarget: (hostId: string) =>
    hostId.startsWith('runtime:')
      ? { kind: 'environment', environmentId: hostId.slice('runtime:'.length) }
      : { kind: 'local' }
}))
// A paired host persists the same way; its replies are adopted under its own runtime: stamp.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (
    target: { environmentId: string },
    _method: string,
    params: { repo: string; updates: object }
  ) => ({
    repo: await harness.persist({
      repoId: params.repo,
      updates: params.updates,
      hostId: `runtime:${target.environmentId}`
    })
  })
}))

const setup = createSetup(harness)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.clearAllMocks()
  harness.onboarding.mockResolvedValue(undefined)
})

describe('Add Project from folder', () => {
  describe('a same-type confirmation replacing the mounted dialog’s request', () => {
    const requestA = { folderPath: '/selected' }
    const requestB = { folderPath: '/other' }
    const added = { ...repo, executionHostId: 'local' as const }
    /** Mounts the dialog on request A, confirms it, and returns once the held step is reached. */
    async function confirmA(store: ReturnType<typeof setup>['store']) {
      store.setState({ activeModal: 'confirm-add-project-from-folder', modalData: requestA })
      const view = render(createElement(AddProjectFromFolderDialog))
      const button = await view.findByRole('button', { name: 'Add Project' })
      await act(async () => {
        button.click()
      })
    }
    function expectBIntact(store: ReturnType<typeof setup>['store']) {
      expect(store.getState().activeModal).toBe('confirm-add-project-from-folder')
      expect(store.getState().modalData).toBe(requestB)
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).not.toHaveBeenCalled()
    }

    it.each([
      ['registers', { repo: added, selectedPath: '/selected' }],
      ['is not a Git repository', { error: 'Not a valid git repository: /selected' }],
      ['fails', { error: 'disk unavailable' }]
    ])('leaves B alone when A’s held add %s', async (outcome, reply) => {
      const { store } = setup([checkout('/repo'), checkout('/selected')], [])
      const addGate = deferred<unknown>()
      harness.add.mockReturnValueOnce(addGate.promise)
      await confirmA(store)
      await vi.waitFor(() => expect(harness.add).toHaveBeenCalled())
      await act(async () => {
        store.setState({ modalData: requestB })
        addGate.resolve(reply)
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expectBIntact(store)
      // The registration itself still commits.
      expect(store.getState().repos.map((row) => row.id)).toEqual(
        outcome === 'registers' ? ['project'] : []
      )
    })

    describe('with a project another profile also knows, stored on a Windows drive', () => {
      const onDrive = { ...added, path: 'C:\\work\\selected' }
      const warningsFor = async (replaceBeforeLookupReturns: boolean) => {
        const { store } = setup([checkout('/repo'), checkout('/selected')], [])
        store.setState({
          activeOrcaProfileId: 'profile-current',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the WSL advisory reads only this setting.
          settings: {
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
          } as AppState['settings']
        })
        harness.add.mockResolvedValueOnce({ repo: onDrive, selectedPath: onDrive.path })
        const lookup = deferred<{ projects: { profileName: string }[] }>()
        harness.findProjectProfiles.mockReturnValueOnce(lookup.promise)
        await confirmA(store)
        await vi.waitFor(() => expect(harness.findProjectProfiles).toHaveBeenCalled())
        await act(async () => {
          if (replaceBeforeLookupReturns) {
            store.setState({ modalData: requestB })
          }
          lookup.resolve({ projects: [{ profileName: 'Work' }] })
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        // The registration itself commits either way.
        expect(store.getState().repos.map((row) => row.id)).toEqual(['project'])
        return { store, warnings: harness.warning.mock.calls.map(([title]) => title) }
      }

      it('warns about neither once a same-type request replaced it during the lookup', async () => {
        const { store, warnings } = await warningsFor(true)
        expect(warnings).toEqual([])
        expect(store.getState().modalData).toBe(requestB)
      })

      it('still warns about both while the request is current', async () => {
        const { warnings } = await warningsFor(false)
        expect(warnings).toEqual([
          'Project also exists in another profile',
          'This project is stored on a Windows drive'
        ])
      })
    })

    it.each([['preliminary refresh'], ['onboarding save']])(
      'leaves B alone when A’s held %s finishes',
      async (step) => {
        const { store } = setup([checkout('/repo'), checkout('/selected')], [])
        harness.add.mockResolvedValueOnce({ repo: added, selectedPath: '/selected' })
        const gate = deferred<boolean>()
        if (step === 'onboarding save') {
          harness.onboarding.mockReturnValueOnce(gate.promise.then(() => undefined))
        } else {
          const refresh = store.getState().fetchWorktrees
          vi.spyOn(store.getState(), 'fetchWorktrees').mockImplementationOnce(async (...args) => {
            await gate.promise
            return refresh(...args)
          })
        }
        await confirmA(store)
        await vi.waitFor(() =>
          expect(store.getState().repos.map((row) => row.id)).toEqual(['project'])
        )
        await act(async () => {
          store.setState({ modalData: requestB })
          gate.resolve(true)
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expectBIntact(store)
      }
    )
  })
})
