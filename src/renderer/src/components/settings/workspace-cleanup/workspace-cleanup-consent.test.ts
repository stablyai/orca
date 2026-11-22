// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceCleanupRules } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPolicyRead,
  WorkspaceCleanupPolicyChange
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  createCleanupChangeRequest,
  cleanupExistingRuleNotice
} from './workspace-cleanup-change-preview'
import { confirmWorkspaceCleanupChange } from './workspace-cleanup-change-confirmation'
import {
  proposedCleanupPolicy,
  type CleanupChangeIntent
} from './workspace-cleanup-rule-change-intent'
import { WorkspaceCleanupKeepSelection } from './workspace-cleanup-keep-selection'
import {
  createWorkspaceCleanupPolicyWrite,
  readCleanupPolicy
} from './workspace-cleanup-policy-client'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))
const row: WorkspaceCleanupPreviewRow = {
  worktreeId: 'repo::/old',
  instanceId: 'old',
  repoId: 'repo',
  repoName: 'Example',
  displayName: 'Old',
  branch: 'old',
  path: '/old',
  sizeBytes: 100,
  evaluation: { action: 'delete', reason: 'inactive' }
}
beforeEach(() => {
  rpc.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
  window.localStorage.clear()
  window.sessionStorage.clear()
})
it.each(['global', 'custom', 'inherit'] as const)(
  'requires renewed review for changed %s policy even with identical deletion rows',
  async (scope) => {
    const rules = {
      ...getDefaultWorkspaceCleanupRules(),
      inactive: { enabled: false, afterDays: 30, action: 'delete' as const }
    }
    const read: WorkspaceCleanupPolicyRead = {
      protocol: 3,
      expiresAt: 1_900_000_060_000,
      state: {
        repoId: scope === 'global' ? null : 'repo',
        rules,
        projects: [
          {
            id: 'repo',
            hostId: 'local',
            policy: scope === 'inherit' ? { mode: 'off' } : { mode: 'custom', rules }
          }
        ]
      }
    }
    const intent: CleanupChangeIntent =
      scope === 'inherit'
        ? { kind: 'inherit', setting: 'mode', mode: 'global' }
        : {
            kind: 'enable',
            setting: 'inactive',
            changeRules: (value) => ({ ...value, inactive: { ...value.inactive, enabled: true } })
          }
    if (scope === 'inherit') {
      read.state.rules.inactive.enabled = true
    }
    const comparison = {
      read: structuredClone(read),
      current: { evaluatedAt: 1, rows: [] },
      next: { evaluatedAt: 1, rows: [row] }
    }
    const change = proposedCleanupPolicy(comparison.read, intent)
    const pending = createCleanupChangeRequest(
      comparison,
      intent,
      change,
      scope === 'global' ? undefined : 'Example'
    )!
    const latest = structuredClone(read)
    if (scope === 'custom') {
      const policy = latest.state.projects[0].policy
      if (policy?.mode === 'custom') {
        policy.rules.inactive.afterDays = 1
      }
    } else {
      latest.state.rules.inactive.afterDays = 1
    }
    rpc.mockImplementation(async (_owner, method) => {
      if (method === 'workspaceCleanup.policyState') {
        return structuredClone(latest)
      }
      if (method === 'workspaceCleanup.previewChange') {
        return {
          ...comparison,
          read: structuredClone(latest)
        }
      }
      throw new Error(`Unexpected mutation ${method}`)
    })
    const refreshed = await confirmWorkspaceCleanupChange(
      { kind: 'local' },
      pending,
      read.state.repoId,
      () => true
    )
    expect(refreshed.kind).toBe('refresh')
    if (refreshed.kind !== 'refresh') {
      throw new Error('Expected review')
    }
    expect(refreshed.request.rows.map((item) => item.displayName)).toEqual(['Old'])
    expect(refreshed.request.status?.policyChanged).toBe(true)
    const result = await confirmWorkspaceCleanupChange(
      { kind: 'local' },
      { ...refreshed.request, intent },
      read.state.repoId,
      () => true
    )
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') {
      throw new Error('Expected confirmed proposal')
    }
    const saved: WorkspaceCleanupPolicyChange = result.change
    const savedRules =
      saved.scope === 'global'
        ? saved.rules
        : saved.policy?.mode === 'custom'
          ? saved.policy.rules
          : result.read.state.rules
    expect(savedRules.inactive.afterDays).toBe(1)
  }
)
it('preserves selection identity and exact visible byte totals across refresh and toggles', () => {
  const second = {
    ...row,
    worktreeId: 'repo::/second',
    instanceId: 'second',
    displayName: 'Second',
    sizeBytes: 250
  }
  const selection = new WorkspaceCleanupKeepSelection([row, second])
  selection.toggle(row)
  selection.toggle(second)
  expect(selection.getSnapshot()).toMatchObject({ count: 2, visibleCount: 2, visibleBytes: 350 })
  const moved = { ...row, instanceId: 'replacement' }
  const refreshed = selection.copyFor([moved, second], new Set(['local:repo::/second:second']))
  expect([...refreshed.rows()].map((item) => item.instanceId)).toEqual(['second'])
  expect(refreshed.getSnapshot()).toMatchObject({ count: 1, visibleCount: 1, visibleBytes: 250 })
  refreshed.toggle(second)
  expect(refreshed.getSnapshot()).toMatchObject({ count: 0, visibleCount: 0, visibleBytes: 0 })
})

it('retains the existing-rule warning after a refresh clears every New marker', () => {
  const current = new Set(['local:repo::/old:old'])
  expect(cleanupExistingRuleNotice([row], new Set(), current)).toBe('some')
  expect(cleanupExistingRuleNotice([row], new Set(), new Set())).toBeNull()
  const added = { ...row, worktreeId: 'repo::/added', instanceId: 'added' }
  expect(
    cleanupExistingRuleNotice([added, row], new Set(['local:repo::/added:added']), current)
  ).toBe('all')
})

it('does not fence another window live writer through a shared localStorage journal', async () => {
  const rules = getDefaultWorkspaceCleanupRules()
  const read: WorkspaceCleanupPolicyRead = {
    protocol: 3,
    expiresAt: 1_900_000_060_000,
    state: { repoId: null, rules, projects: [] }
  }
  const reserved = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let live = false,
    cancelled = false,
    saved = false
  rpc.mockImplementation(async (_owner, method) => {
    if (method === 'workspaceCleanup.reservePolicyWrite') {
      live = true
      reserved.resolve()
      await release.promise
      if (cancelled) {
        throw new Error('Cancelled live writer')
      }
      return { reserved: true }
    }
    if (method === 'workspaceCleanup.settlePolicyWrite') {
      cancelled = true
      live = false
      return { outcome: 'cancelled' }
    }
    if (
      method === 'workspaceCleanup.policyState' ||
      method === 'workspaceCleanup.recoverPolicyWrites'
    ) {
      return { ...read, pendingWrites: live }
    }
    if (method === 'settings.update') {
      saved = true
      live = false
      return {}
    }
    throw new Error(`Unexpected request ${method}`)
  })
  const write = createWorkspaceCleanupPolicyWrite(
    { kind: 'local' },
    {
      scope: 'global',
      rules: { ...rules, merged: { enabled: true } }
    },
    read
  )
  const pending = write.send()
  await reserved.promise
  window.sessionStorage.setItem('orca:cleanup-write-client', 'second-window')
  await expect(readCleanupPolicy({ kind: 'local' }, null)).rejects.toThrow(
    'workspace_cleanup_write_pending'
  )
  release.resolve()
  await pending
  expect(saved).toBe(true)
  expect(cancelled).toBe(false)
})

it.each(['global', 'project'] as const)(
  'distinguishes a refused %s save from a concurrent edit',
  async (scope) => {
    for (const changed of [false, true]) {
      const rules = getDefaultWorkspaceCleanupRules()
      const read: WorkspaceCleanupPolicyRead = {
        protocol: 3,
        expiresAt: 1_900_000_060_000,
        state: {
          repoId: scope === 'global' ? null : 'repo',
          rules,
          projects: [{ id: 'repo', hostId: 'local', policy: { mode: 'custom', rules } }]
        }
      }
      const desired = { ...rules, merged: { ...rules.merged, enabled: true } }
      const change: WorkspaceCleanupPolicyChange =
        scope === 'global'
          ? { scope: 'global', rules: desired }
          : { scope: 'project', repoId: 'repo', policy: { mode: 'custom', rules: desired } }
      const actual = structuredClone(read)
      if (changed) {
        if (scope === 'global') {
          actual.state.rules.inactive.afterDays = 1
        } else if (actual.state.projects[0].policy?.mode === 'custom') {
          actual.state.projects[0].policy.rules.inactive.afterDays = 1
        }
      }
      rpc.mockImplementation(async (_owner, method) => {
        if (method === 'workspaceCleanup.settlePolicyWrite') {
          return { outcome: 'cancelled' }
        }
        if (method === 'workspaceCleanup.policyState') {
          return actual
        }
        throw new Error(`Unexpected method ${method}`)
      })
      const write = createWorkspaceCleanupPolicyWrite({ kind: 'local' }, change, read)
      expect((await write.settle()).outcome).toBe(changed ? 'conflict' : 'failed')
    }
  }
)
