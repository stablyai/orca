import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BEADS_TASK_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  clearBeadsTaskResumeCapabilityCacheForTests,
  gateTaskResumeStateForHost,
  stripBeadsTaskResumeKeys,
  taskResumeStateHasBeadsKeys
} from './web-task-resume-beads-gate'

function statusWithCapabilities(capabilities: string[]): RuntimeStatus {
  return { capabilities } as unknown as RuntimeStatus
}

const beadsUpdates = {
  taskResumeState: {
    githubItemsQuery: 'is:open',
    jiraQuery: 'mine',
    beadsPreset: 'ready' as const,
    beadsQuery: 'auth'
  }
}

describe('taskResumeStateHasBeadsKeys', () => {
  it('detects beads keys and ignores payloads without them', () => {
    expect(taskResumeStateHasBeadsKeys(beadsUpdates)).toBe(true)
    expect(taskResumeStateHasBeadsKeys({ taskResumeState: { githubItemsQuery: 'x' } })).toBe(false)
    expect(taskResumeStateHasBeadsKeys({})).toBe(false)
  })
})

describe('stripBeadsTaskResumeKeys', () => {
  it('removes only the beads keys and keeps the rest of the resume state', () => {
    expect(stripBeadsTaskResumeKeys(beadsUpdates).taskResumeState).toEqual({
      githubItemsQuery: 'is:open',
      jiraQuery: 'mine'
    })
  })
})

describe('gateTaskResumeStateForHost', () => {
  beforeEach(() => {
    clearBeadsTaskResumeCapabilityCacheForTests()
  })

  it('passes beads keys through when the host advertises the capability', async () => {
    const gated = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-1',
      getStatus: async () => statusWithCapabilities([BEADS_TASK_SOURCE_RUNTIME_CAPABILITY])
    })
    expect(gated).toEqual(beadsUpdates)
  })

  it('strips beads keys for a pre-beads host but keeps github/jira resume state', async () => {
    const gated = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-1',
      getStatus: async () => statusWithCapabilities([])
    })
    expect(gated.taskResumeState).toEqual({ githubItemsQuery: 'is:open', jiraQuery: 'mine' })
  })

  it('skips the status probe entirely when no beads keys are present', async () => {
    const getStatus = vi.fn()
    const updates = { taskResumeState: { githubItemsQuery: 'is:open' } }
    const gated = await gateTaskResumeStateForHost({
      updates,
      environmentId: 'env-1',
      getStatus
    })
    expect(gated).toBe(updates)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('caches a supported verdict per environment and re-probes a different environment', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(statusWithCapabilities([BEADS_TASK_SOURCE_RUNTIME_CAPABILITY]))
      .mockResolvedValueOnce(statusWithCapabilities([]))
    await gateTaskResumeStateForHost({ updates: beadsUpdates, environmentId: 'env-1', getStatus })
    const second = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-1',
      getStatus
    })
    expect(second).toEqual(beadsUpdates)
    expect(getStatus).toHaveBeenCalledTimes(1)

    const otherHost = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-2',
      getStatus
    })
    expect(otherHost.taskResumeState).toEqual({ githubItemsQuery: 'is:open', jiraQuery: 'mine' })
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('strips without caching when the probe fails, and when unpaired', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'))
    const gated = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-1',
      getStatus: failing
    })
    expect(gated.taskResumeState).toEqual({ githubItemsQuery: 'is:open', jiraQuery: 'mine' })

    // A later successful probe recovers immediately (failure was not cached).
    const recovered = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: 'env-1',
      getStatus: async () => statusWithCapabilities([BEADS_TASK_SOURCE_RUNTIME_CAPABILITY])
    })
    expect(recovered).toEqual(beadsUpdates)

    const unpaired = await gateTaskResumeStateForHost({
      updates: beadsUpdates,
      environmentId: null,
      getStatus: failing
    })
    expect(unpaired.taskResumeState).toEqual({ githubItemsQuery: 'is:open', jiraQuery: 'mine' })
  })
})
