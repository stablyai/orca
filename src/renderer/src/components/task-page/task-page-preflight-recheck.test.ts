import { expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api/preflight/preflight-api'
import { needsTargetedPreflightRefresh } from './task-page-preflight-recheck'

type Args = Parameters<typeof needsTargetedPreflightRefresh>[0]

const ready: PreflightStatus = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true }
}

function args(overrides: Partial<Args> = {}): Args {
  return {
    taskSource: 'github',
    hasRepoContexts: true,
    preflightStatus: ready,
    preflightStatusChecked: true,
    preflightStatusCurrent: true,
    preflightDescribesDesktop: true,
    ...overrides
  }
}

it('refreshes once when GitHub is signed out for selected repos', () => {
  expect(
    needsTargetedPreflightRefresh(
      args({ preflightStatus: { ...ready, gh: { installed: true, authenticated: false } } })
    )
  ).toBe(true)
})

it('refreshes when the needed tool is not installed or is missing on the server', () => {
  expect(
    needsTargetedPreflightRefresh(
      args({ preflightStatus: { ...ready, gh: { installed: false, authenticated: false } } })
    )
  ).toBe(true)
  expect(
    needsTargetedPreflightRefresh(
      args({ preflightStatus: { git: { installed: true }, gh: ready.gh } })
    )
  ).toBe(false)
})

it('uses glab for GitLab repos', () => {
  expect(
    needsTargetedPreflightRefresh(
      args({
        taskSource: 'gitlab',
        preflightStatus: { ...ready, glab: { installed: true, authenticated: false } }
      })
    )
  ).toBe(true)
})

it('does not refresh a ready or irrelevant status', () => {
  expect(needsTargetedPreflightRefresh(args())).toBe(false)
  expect(needsTargetedPreflightRefresh(args({ preflightStatusCurrent: false }))).toBe(false)
  expect(needsTargetedPreflightRefresh(args({ preflightStatusChecked: false }))).toBe(false)
  expect(needsTargetedPreflightRefresh(args({ preflightDescribesDesktop: false }))).toBe(false)
  expect(needsTargetedPreflightRefresh(args({ hasRepoContexts: false }))).toBe(false)
  expect(needsTargetedPreflightRefresh(args({ taskSource: 'linear' }))).toBe(false)
})
