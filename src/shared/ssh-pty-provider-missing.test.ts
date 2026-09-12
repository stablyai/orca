import { describe, expect, it } from 'vitest'
import {
  formatRuntimeOwnedSshRelayNotAttached,
  formatRuntimeOwnedSshRelayReattachFailed,
  formatSshPtyProviderMissingError,
  parseRuntimeOwnedSshRelayMiss
} from './ssh-pty-provider-missing'

const ID = 'runtime-ssh-orca-3bc4d819'

describe('runtime-owned SSH provider-miss messages', () => {
  it('never tells a runtime-owned target to use a host-list Reconnect it does not have', () => {
    // Why: `listTargets()` excludes runtime-owned rows, so "use Reconnect on the SSH target"
    // names a control that does not exist for them — the reporter's symptom (d).
    for (const message of [
      formatRuntimeOwnedSshRelayNotAttached(ID),
      formatRuntimeOwnedSshRelayReattachFailed(ID, 'connect ECONNREFUSED 127.0.0.1:51816')
    ]) {
      expect(message).toMatch(/^No PTY provider for connection "runtime-ssh-orca-3bc4d819": /)
      expect(message).not.toMatch(/Reconnect/)
      expect(message).toMatch(/Open the workspace again or start a new terminal to retry\.$/)
    }
  })

  it('separates the cause from the retry hint with a sentence break', () => {
    // Why: the author's own proof transcript showed "…51816 Open the workspace…" run together.
    expect(
      formatRuntimeOwnedSshRelayReattachFailed(ID, 'connect ECONNREFUSED 127.0.0.1:51816')
    ).toBe(
      'No PTY provider for connection "runtime-ssh-orca-3bc4d819": the SSH relay for this workspace ' +
        'could not be re-attached: connect ECONNREFUSED 127.0.0.1:51816. ' +
        'Open the workspace again or start a new terminal to retry.'
    )
    expect(formatRuntimeOwnedSshRelayReattachFailed(ID, 'timed out.')).toContain(
      're-attached: timed out. Open the workspace'
    )
  })

  it.each([
    ['not-attached', formatRuntimeOwnedSshRelayNotAttached(ID), { kind: 'not-attached' }],
    [
      'reattach-failed',
      formatRuntimeOwnedSshRelayReattachFailed(ID, 'connect ECONNREFUSED 127.0.0.1:51816'),
      { kind: 'reattach-failed', cause: 'connect ECONNREFUSED 127.0.0.1:51816' }
    ],
    [
      'reattach-failed wrapped by Electron invoke',
      `Error invoking remote method 'pty:spawn': ${formatRuntimeOwnedSshRelayReattachFailed(ID, 'SSH relay for runtime "orca-1" did not attach within 15s.')}`,
      { kind: 'reattach-failed', cause: 'SSH relay for runtime "orca-1" did not attach within 15s' }
    ],
    [
      'an unrecognised detail',
      formatSshPtyProviderMissingError(ID, 'something else entirely.'),
      { kind: 'other', detail: 'something else entirely' }
    ],
    [
      'a bare prefix with no detail',
      `No PTY provider for connection "${ID}"`,
      { kind: 'not-attached' }
    ]
  ])('parses %s back out for the renderer', (_label, message, expected) => {
    expect(parseRuntimeOwnedSshRelayMiss(message)).toEqual(expected)
  })
})
