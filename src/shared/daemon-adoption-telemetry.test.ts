import { describe, expect, it } from 'vitest'

import { eventSchemas } from './telemetry-event-registry'

// The reset remedy is offered for exactly these classes, so main and the fix dialog must agree.

// Privacy invariant: enum-only. A raw path, version, or exact count must be rejected by .strict().
describe('daemon_adopted / daemon_pty_cwd_denied schemas', () => {
  const adopted = {
    app_version_match: 'different',
    spawner_path_class: 'updater-cache',
    code_identity: 'unresolvable',
    tcc_attribution: 'intact',
    live_session_count_bucket: '2-5'
  }
  const denied = {
    cwd_class: 'documents',
    app_version_match: 'different',
    spawner_path_class: 'updater-cache',
    code_identity: 'parked'
  }

  it('rejects leaked paths, versions, counts, and unknown enum values', () => {
    for (const leak of [
      { spawner_exec_path: '/Users/alice/Library/Caches/ShipIt/Orca.app' },
      { app_version: '1.4.187' },
      { live_session_count: 3 },
      { cwd: '/Users/alice/Documents' }
    ]) {
      expect(eventSchemas.daemon_adopted.safeParse({ ...adopted, ...leak }).success).toBe(false)
      expect(eventSchemas.daemon_pty_cwd_denied.safeParse({ ...denied, ...leak }).success).toBe(
        false
      )
    }
    expect(
      eventSchemas.daemon_adopted.safeParse({ ...adopted, spawner_path_class: '/Applications' })
        .success
    ).toBe(false)
    expect(
      eventSchemas.daemon_pty_cwd_denied.safeParse({ ...denied, cwd_class: 'Documents' }).success
    ).toBe(false)
    expect(
      eventSchemas.daemon_adopted.safeParse({ ...adopted, code_identity: 'severed' }).success
    ).toBe(false)
    expect(
      eventSchemas.daemon_pty_cwd_readable.safeParse({ ...denied, launch_method: 'stable-copy' })
        .success
    ).toBe(false)
    expect(
      eventSchemas.daemon_pty_cwd_readable.safeParse({
        ...denied,
        spawner_path_class: 'stable-copy'
      }).success
    ).toBe(true)
  })
})

// Match the denied-event enum-only privacy budget: no daemon scope, path or folder name.
describe('daemon_folder_access_notice schema', () => {
  const shown = { action: 'shown', cwd_class: 'documents' }

  it('rejects an unknown action, an unknown class, and any extra field', () => {
    for (const bad of [
      { action: 'open_manage_sessions' },
      { cwd_class: 'Documents' },
      { daemon_scope: 'aaaa111122223333' },
      { cwd: '/Users/alice/Documents' }
    ]) {
      expect(eventSchemas.daemon_folder_access_notice.safeParse({ ...shown, ...bad }).success).toBe(
        false
      )
    }
  })
})
