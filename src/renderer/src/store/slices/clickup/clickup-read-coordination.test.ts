import { describe, expect, it } from 'vitest'
import { getSettingsFocusedExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { clickupOwnerContextKey } from './clickup-read-coordination'

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
