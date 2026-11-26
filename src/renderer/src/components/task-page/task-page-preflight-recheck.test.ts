import { expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api/preflight/preflight-api'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/work-items/task-source-context'
import type { RuntimeProviderPreflightStatus } from './source-selection/task-source-provider-availability'
import { selectProviderPreflightRefreshTargets } from './task-page-preflight-recheck'

type Args = Parameters<typeof selectProviderPreflightRefreshTargets>[0]

const ready: PreflightStatus = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true }
}
const signedOut: PreflightStatus = { ...ready, gh: { installed: true, authenticated: false } }
const localContext = context('local')
const runtimeHostId = 'runtime:env-1'
const runtimeContext = context(runtimeHostId)

function context(hostId: string): TaskSourceContext {
  const value = normalizeTaskSourceContext({ provider: 'github', projectId: 'p', hostId })
  if (!value) {
    throw new Error('invalid task source context')
  }
  return value
}

function args(overrides: Partial<Args> = {}): Args {
  return {
    taskSource: 'github',
    contexts: [localContext],
    preflightStatus: ready,
    preflightStatusChecked: true,
    preflightStatusCurrent: true,
    preflightDescribesDesktop: true,
    desktopPreflightFailed: false,
    runtimePreflightStatusByHostId: new Map(),
    ...overrides
  }
}

function runtimeMap(
  status: PreflightStatus,
  checked = true
): ReadonlyMap<TaskSourceContext['hostId'], RuntimeProviderPreflightStatus> {
  return new Map([[runtimeHostId, { checked, status }]])
}

it('targets the desktop when gh is signed out for a desktop repo', () => {
  expect(selectProviderPreflightRefreshTargets(args({ preflightStatus: signedOut }))).toEqual({
    desktop: true,
    runtimeHostIds: []
  })
  expect(
    selectProviderPreflightRefreshTargets(
      args({ preflightStatus: { ...ready, gh: { installed: false, authenticated: false } } })
    )
  ).toEqual({ desktop: true, runtimeHostIds: [] })
})

it('uses glab for GitLab repos', () => {
  expect(
    selectProviderPreflightRefreshTargets(
      args({
        taskSource: 'gitlab',
        preflightStatus: {
          ...ready,
          glab: { installed: true, authenticated: false }
        }
      })
    )
  ).toEqual({ desktop: true, runtimeHostIds: [] })
})

it('targets a runtime host whose provider is stale', () => {
  expect(
    selectProviderPreflightRefreshTargets(
      args({
        contexts: [runtimeContext],
        runtimePreflightStatusByHostId: runtimeMap(signedOut)
      })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [runtimeHostId] })
})

it('targets both desktop and runtime when both are stale', () => {
  expect(
    selectProviderPreflightRefreshTargets(
      args({
        contexts: [localContext, runtimeContext],
        preflightStatus: signedOut,
        runtimePreflightStatusByHostId: runtimeMap(signedOut)
      })
    )
  ).toEqual({ desktop: true, runtimeHostIds: [runtimeHostId] })
})

it('treats a failed desktop request as stale and keeps runtime targets independent', () => {
  expect(
    selectProviderPreflightRefreshTargets(
      args({ desktopPreflightFailed: true, preflightStatus: null })
    )
  ).toEqual({ desktop: true, runtimeHostIds: [] })

  expect(
    selectProviderPreflightRefreshTargets(
      args({
        contexts: [localContext, runtimeContext],
        desktopPreflightFailed: true,
        preflightStatus: null,
        runtimePreflightStatusByHostId: runtimeMap(signedOut)
      })
    )
  ).toEqual({ desktop: true, runtimeHostIds: [runtimeHostId] })
})

it('does not force an unchecked runtime status', () => {
  expect(
    selectProviderPreflightRefreshTargets(
      args({
        contexts: [runtimeContext],
        runtimePreflightStatusByHostId: runtimeMap(signedOut, false)
      })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [] })
})

it('does not force a ready or irrelevant status', () => {
  expect(selectProviderPreflightRefreshTargets(args())).toEqual({
    desktop: false,
    runtimeHostIds: []
  })
  expect(
    selectProviderPreflightRefreshTargets(
      args({ preflightStatusCurrent: false, preflightStatus: signedOut })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [] })
  expect(
    selectProviderPreflightRefreshTargets(
      args({ preflightStatusChecked: false, preflightStatus: signedOut })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [] })
  expect(
    selectProviderPreflightRefreshTargets(
      args({ preflightDescribesDesktop: false, preflightStatus: signedOut })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [] })
  expect(
    selectProviderPreflightRefreshTargets(
      args({ taskSource: 'linear', preflightStatus: signedOut })
    )
  ).toEqual({ desktop: false, runtimeHostIds: [] })
})
