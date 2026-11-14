// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../components/settings/__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { createProjectGroup } from '../../../shared/project-groups'
import { PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { useSupportedGroupHookSettings } from './use-supported-group-hook-settings'

it('keeps Archive unavailable on Setup-only hosts and shares capability inspection across their groups', async () => {
  // Two hosts need two status replies, regardless of how many groups they own.
  for (const count of [10, 100]) {
    clearRuntimeCompatibilityCache()
    const call = vi.fn(async ({ selector }: { selector: string }) => {
      const response = createCompatibleRuntimeStatusResponse(selector)
      if (selector === 'setup-only') {
        response.result.capabilities = response.result.capabilities?.filter(
          (capability) => capability !== PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
        )
      }
      return response
    })
    Object.defineProperty(window.api, 'runtimeEnvironments', {
      configurable: true,
      value: { call }
    })
    const projectGroups = Array.from({ length: count }, (_, i) => ({
      ...createProjectGroup({
        name: `Group ${i}`,
        parentPath: `/groups/${i}`,
        createdFrom: 'manual',
        tabOrder: i
      }),
      executionHostId: i % 2 === 0 ? 'runtime:modern' : 'runtime:setup-only'
    }))
    act(() => useAppStore.setState({ projectGroups }))
    const view = renderHook(() => useSupportedGroupHookSettings())
    await waitFor(() => expect(view.result.current).toHaveLength(count))
    expect(view.result.current.map((group) => group.supportsArchiveHooks)).toEqual(
      Array.from({ length: count / 2 }, () => [true, false]).flat()
    )
    expect(call.mock.calls.map(([request]) => request.selector).sort()).toEqual([
      'modern',
      'setup-only'
    ])
    for (const name of ['Renamed group', 'Renamed again']) {
      await act(async () =>
        useAppStore.setState((state) => ({
          projectGroups: state.projectGroups.map((group, i) =>
            i === 0
              ? {
                  ...group,
                  name,
                  hookSettings: {
                    mode: 'override' as const,
                    scripts: { setup: `echo ${name}`, archive: '' }
                  }
                }
              : group
          )
        }))
      )
      expect(view.result.current[0].name).toBe(name)
      expect(call).toHaveBeenCalledTimes(2)
    }
    act(() => useAppStore.setState({ settingsSearchQuery: 'Archive' }))
    expect(call).toHaveBeenCalledTimes(2)
    act(() =>
      useAppStore.setState((state) => ({
        projectGroups: [
          ...state.projectGroups,
          { ...projectGroups[0], id: 'new-host-group', executionHostId: 'runtime:new-host' }
        ]
      }))
    )
    await waitFor(() => expect(view.result.current).toHaveLength(count + 1))
    expect(view.result.current.at(-1)?.supportsArchiveHooks).toBe(true)
    expect(call.mock.calls.filter(([request]) => request.selector === 'new-host')).toHaveLength(1)
    view.unmount()
  }
})
