import { describe, expect, it, vi } from 'vitest'
import { getSettingsFocusedExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { createTestStore } from '../../testing/app-store-test-fixture'
import {
  beginClickUpConnectionChange,
  cachedClickUpRead,
  clickupOwnerContextKey,
  clickupWorkspaceCachePrefix,
  noteClickUpStatusWrite,
  type ClickUpReadScope
} from './clickup-read-coordination'

describe('clickupOwnerContextKey', () => {
  // The Tasks page and Settings status effects compare the stored status key against the focused
  // server's key; an owner that keys differently would re-check ClickUp forever.
  it.each([null, '', '  ', 'env-1', ' env 1 ', 'a|b', 'é/x'])(
    'keys an owner like the focused server for activeRuntimeEnvironmentId %j',
    (activeRuntimeEnvironmentId) => {
      const settings = { activeRuntimeEnvironmentId }
      const expected = getProviderRuntimeContextKey(settings)

      expect(clickupOwnerContextKey(defaultScopeHost(settings))).toBe(expected)
      expect(
        clickupOwnerContextKey(
          taskSourceRuntimeTarget({ hostId: getSettingsFocusedExecutionHostId(settings) })
        )
      ).toBe(expected)
    }
  )
})

describe('cachedClickUpRead across status writes', () => {
  const scope: ClickUpReadScope = {
    contextKey: 'coordination-test',
    runtimeContextKey: 'coordination-runtime',
    target: { kind: 'local' },
    workspaceKey: 'id:coordination',
    workspaceId: 'coordination'
  }
  const prefix = clickupWorkspaceCachePrefix(scope.runtimeContextKey, scope.workspaceKey)

  function read(
    key: string,
    load: () => Promise<string>,
    extra: { signal?: AbortSignal } = {}
  ): { result: Promise<string>; stored: string[] } {
    const stored: string[] = []
    const result = cachedClickUpRead({
      key,
      scope,
      get: createTestStore().getState,
      force: true,
      carriesTaskStatus: true,
      peek: () => undefined,
      store: (entry) => {
        if (entry.data !== null) {
          stored.push(entry.data)
        }
      },
      load,
      ...extra
    })
    return { result, stored }
  }

  it('reloads at most twice while writes keep succeeding, then caches the last result', async () => {
    let loads = 0
    const load = vi.fn(async () => {
      loads += 1
      noteClickUpStatusWrite(prefix)
      return `load-${loads}`
    })

    const { result, stored } = read('cap', load)

    await expect(result).resolves.toBe('load-3')
    expect(load).toHaveBeenCalledTimes(3)
    expect(stored).toEqual(['load-3'])
  })

  it('does not reload when no write succeeded meanwhile', async () => {
    const load = vi.fn(async () => 'only')

    await expect(read('quiet', load).result).resolves.toBe('only')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not reload once the read was aborted', async () => {
    const controller = new AbortController()
    const load = vi.fn(async () => {
      noteClickUpStatusWrite(prefix)
      controller.abort()
      return 'aborted'
    })

    await read('aborted', load, { signal: controller.signal }).result
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not reload, nor cache, after a connection change', async () => {
    const load = vi.fn(async () => {
      noteClickUpStatusWrite(prefix)
      beginClickUpConnectionChange()
      return 'old-connection'
    })

    const { result, stored } = read('connection', load)

    await expect(result).resolves.toBe('old-connection')
    expect(load).toHaveBeenCalledTimes(1)
    expect(stored).toEqual([])
  })
})
