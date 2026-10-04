import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-event-registry'
import { WORKTREE_CREATE_PHASES } from './worktree/create-timing-vocabulary'

const created = eventSchemas.workspace_created
const failed = eventSchemas.workspace_create_failed

const fullCreatedPayload = {
  source: 'command_palette',
  from_existing_branch: false,
  nth_repo_added: 3,
  total_ms: 8_412,
  unattributed_ms: 311,
  refresh_base_ref_ms: 2_040,
  git_worktree_add_ms: 4_900,
  prepared_checkout_claim_ms: 12,
  prepared_checkout_wait_ms: 3_100,
  prepared_checkout_finalize_ms: 120,
  list_created_worktree_ms: 640,
  spawn_startup_terminal_ms: 90,
  prepared_checkout: 'hit',
  prepared_checkout_reset: 'retargeted',
  prepared_checkout_origin: 'rearm_then_prefetch',
  prepared_checkout_build_ms: 41_000,
  prepared_checkout_idle_ms: 0,
  create_entry_point: 'runtime',
  execution_host: 'wsl',
  worktree_count_bucket: '301-1000',
  repo_file_count_bucket: '100k-500k',
  concurrent_creates: 2,
  concurrent_preparations: 1,
  post_checkout_hook: 'present'
}

describe('workspace_created timing fields', () => {
  it('still accepts the payload that predates the timing fields', () => {
    expect(created.safeParse({ source: 'sidebar', from_existing_branch: true }).success).toBe(true)
  })

  it('accepts a full payload', () => {
    expect(created.safeParse(fullCreatedPayload).success).toBe(true)
  })

  it('accepts a duration for every timed phase', () => {
    const phases = Object.fromEntries(WORKTREE_CREATE_PHASES.map((phase) => [`${phase}_ms`, 1]))
    expect(created.safeParse({ ...fullCreatedPayload, ...phases }).success).toBe(true)
  })

  it('accepts a miss with its reason', () => {
    const parsed = created.safeParse({
      source: 'sidebar',
      from_existing_branch: false,
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'none_armed'
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    ['repo_path', '/Users/alice/secret-repo'],
    ['branch', 'alice/feature'],
    ['base_ref', 'origin/main'],
    ['hook_content', '#!/bin/sh\ngit lfs post-checkout'],
    ['fetch_ms', 10]
  ])('rejects the unknown key %s via .strict()', (key, value) => {
    expect(created.safeParse({ ...fullCreatedPayload, [key]: value }).success).toBe(false)
  })

  it.each([
    ['total_ms', '8412'],
    ['total_ms', -1],
    ['git_worktree_add_ms', 1.5],
    ['concurrent_creates', -1],
    ['concurrent_preparations', 0.5],
    ['prepared_checkout', 'maybe'],
    ['prepared_checkout_reset', 'hard'],
    ['prepared_checkout_origin', 'dialog'],
    ['create_entry_point', 'cli'],
    ['repo_file_count_bucket', '12000'],
    ['prepared_checkout_idle_ms', -5],
    ['prepared_checkout_miss_reason', 'the branch alice/feature was missing'],
    ['execution_host', 'docker'],
    ['worktree_count_bucket', '812'],
    ['post_checkout_hook', 'lfs']
  ])('rejects %s = %j', (key, value) => {
    expect(created.safeParse({ ...fullCreatedPayload, [key]: value }).success).toBe(false)
  })
})

describe('workspace_create_failed timing fields', () => {
  it('still accepts the payload that predates the timing fields', () => {
    expect(failed.safeParse({ source: 'sidebar', error_class: 'git_failed' }).success).toBe(true)
  })

  it('accepts the failing phase and elapsed time', () => {
    const parsed = failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed',
      failed_phase: 'git_worktree_add',
      total_ms: 120_000,
      create_entry_point: 'app',
      execution_host: 'ssh',
      concurrent_creates: 0,
      concurrent_preparations: 0
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts the prepared-checkout outcome and wait of the failed create', () => {
    const parsed = failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed',
      failed_phase: 'git_worktree_add',
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'finalize_failed',
      prepared_checkout_wait_ms: 209_000
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a failure outside every timed phase', () => {
    const parsed = failed.safeParse({
      source: 'sidebar',
      error_class: 'unknown',
      failed_phase: 'untimed'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a phase outside the closed vocabulary', () => {
    const parsed = failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed',
      failed_phase: 'fatal: could not create work tree'
    })
    expect(parsed.success).toBe(false)
  })

  it.each([
    ['post_checkout_hook', 'present'],
    ['repo_file_count_bucket', '<1k'],
    ['git_worktree_add_ms', 10]
  ])('rejects the success-only field %s via .strict()', (key, value) => {
    const parsed = failed.safeParse({ source: 'sidebar', error_class: 'git_failed', [key]: value })
    expect(parsed.success).toBe(false)
  })
})
