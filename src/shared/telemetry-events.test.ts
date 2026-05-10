// Schema round-trip coverage for the event map. Fail-closed invariants that
// must hold: agent_error is enum-only (error_message / error_stack rejected
// by `.strict()`), unknown enum values fail, and any well-formed payload
// round-trips without coercion.

import { describe, expect, it } from 'vitest'
import {
  addRepoSetupStepActionSchema,
  AGENT_KIND_VALUES,
  agentKindSchema,
  commonPropsSchema,
  errorClassSchema,
  eventSchemas,
  SETTINGS_CHANGED_WHITELIST,
  settingsChangedKeySchema
} from './telemetry-events'

describe('agent_error schema', () => {
  it('round-trips a minimal {error_class, agent_kind} payload', () => {
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'unknown',
      agent_kind: 'claude-code'
    })
    expect(parsed.success).toBe(true)
  })

  // Core invariant: `.strict()` rejects raw error strings. If this test ever
  // flips, the analytics lane is leaking UGC — revert the offending schema
  // change.
  it('rejects error_message via .strict()', () => {
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_message: 'boom at /Users/alice/secret/path'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects error_stack via .strict()', () => {
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_stack: 'Error: boom\n    at /Users/alice/...'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects error_name (deferred — schema is enum-only)', () => {
    // `error_name` was part of an earlier draft. The trimmed schema is
    // enum-only; if a future PR re-introduces it as additive-optional,
    // this test should be replaced rather than relaxed silently.
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_name: 'BinaryNotFound'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown error_class enum values', () => {
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'made_up_class',
      agent_kind: 'claude-code'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown agent_kind enum values', () => {
    const parsed = eventSchemas.agent_error.safeParse({
      error_class: 'unknown',
      agent_kind: 'made_up_agent'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('workspace_created schema', () => {
  it('rejects unknown source', () => {
    const parsed = eventSchemas.workspace_created.safeParse({
      source: 'carrier_pigeon',
      from_existing_branch: false
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a valid payload', () => {
    const parsed = eventSchemas.workspace_created.safeParse({
      source: 'command_palette',
      from_existing_branch: true
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects extra keys via .strict()', () => {
    const parsed = eventSchemas.workspace_created.safeParse({
      source: 'command_palette',
      from_existing_branch: true,
      branch: 'refs/heads/main' // raw branch name is UGC — rejected by .strict()
    })
    expect(parsed.success).toBe(false)
  })
})

describe('agent_started schema', () => {
  it('requires all three keys', () => {
    const parsed = eventSchemas.agent_started.safeParse({
      agent_kind: 'claude-code',
      launch_source: 'sidebar'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('add_repo_setup_step_action schema', () => {
  it('accepts every Setup-step action declared in the schema', () => {
    for (const action of addRepoSetupStepActionSchema.options) {
      const parsed = eventSchemas.add_repo_setup_step_action.safeParse({ action })
      expect(parsed.success).toBe(true)
    }
  })

  it('rejects unknown action enum values', () => {
    const parsed = eventSchemas.add_repo_setup_step_action.safeParse({
      action: 'export_to_pdf'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects extra keys via .strict()', () => {
    const parsed = eventSchemas.add_repo_setup_step_action.safeParse({
      action: 'skip',
      repo_name: 'orca' // raw repo names are UGC — must not cross the wire
    })
    expect(parsed.success).toBe(false)
  })
})

describe('workspace_create_failed schema', () => {
  it('accepts a valid payload', () => {
    const parsed = eventSchemas.workspace_create_failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown error_class values', () => {
    const parsed = eventSchemas.workspace_create_failed.safeParse({
      source: 'sidebar',
      error_class: 'cosmic_ray'
    })
    expect(parsed.success).toBe(false)
  })

  // Core invariant mirroring agent_error: raw error strings never cross the
  // wire. If this test ever flips, the failure-rate lane is leaking UGC —
  // revert the offending schema change.
  it('rejects error_message via .strict()', () => {
    const parsed = eventSchemas.workspace_create_failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed',
      error_message: 'fatal: cannot create work tree at /Users/alice/secret'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects error_stack via .strict()', () => {
    const parsed = eventSchemas.workspace_create_failed.safeParse({
      source: 'sidebar',
      error_class: 'git_failed',
      error_stack: 'Error: cannot create work tree\n    at /Users/alice/...'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('settings_changed schema', () => {
  it('accepts whitelisted setting keys', () => {
    for (const key of SETTINGS_CHANGED_WHITELIST) {
      const parsed = eventSchemas.settings_changed.safeParse({
        setting_key: key,
        value_kind: 'bool'
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('rejects non-whitelisted setting keys', () => {
    const parsed = eventSchemas.settings_changed.safeParse({
      setting_key: 'telemetryOptIn', // deliberately excluded from the whitelist
      value_kind: 'bool'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('commonPropsSchema', () => {
  it('round-trips a realistic payload', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '00000000-0000-4000-8000-000000000000',
      session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects strings past the 64-char cap', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: 'x'.repeat(65),
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '00000000-0000-4000-8000-000000000000',
      session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(false)
  })

  // Empty `install_id` would collapse every event under one synthetic
  // PostHog `distinctId`; empty `session_id` would blend unrelated process
  // lifetimes. `.min(1)` guards both — this test pins that contract so a
  // future edit can't relax it back to `.max(64)`-only.
  it('rejects empty install_id', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '',
      session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects empty session_id', () => {
    const parsed = commonPropsSchema.safeParse({
      app_version: '1.3.33',
      platform: 'darwin',
      arch: 'arm64',
      os_release: '25.3.0',
      install_id: '00000000-0000-4000-8000-000000000000',
      session_id: '',
      orca_channel: 'stable'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('exported enum schemas', () => {
  it('agentKindSchema accepts the known product IDs', () => {
    for (const kind of AGENT_KIND_VALUES) {
      expect(agentKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  it('errorClassSchema rejects novel classes', () => {
    expect(errorClassSchema.safeParse('kernel_panic').success).toBe(false)
  })

  it('settingsChangedKeySchema membership matches SETTINGS_CHANGED_WHITELIST', () => {
    for (const key of SETTINGS_CHANGED_WHITELIST) {
      expect(settingsChangedKeySchema.safeParse(key).success).toBe(true)
    }
  })
})
