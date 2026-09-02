# STA-5698 relay epoch gate lifetime fix

## Diagnosis to verify

The runtime failures share the retired-owner side table's identity/lifetime bug. A
`(connectionId, paneKey)` tombstone is consumed by whichever later spawn happens to
use that pane, so a later same-relay restore can compare against an unrelated old
epoch. Conversely, a failed fresh spawn consumes the only tombstone before a relay
replacement retries the same absence, making that retry `unknown` and allowing the
resume.

## Design

The first proposal to key by `effectiveSessionAppId` is rejected: fresh resume paths
intentionally omit `sessionId`, so that value cannot identify the absence. The fix is
scoped to direct IPC/SSH paths that reproduce STA-5698; paired-runtime methods and
stream opcodes remain unchanged. Relay retirement (including the synthetic
`webContents.send('pty:exit', {id, code:-1})` in
`ssh-relay-session.handlePtyReattachFailure`) records `{connectionId,paneKey,ownerPtyId}`
in the bounded main-process map. No renderer wire shape changes: this map is consulted
only by the main process when a fresh IPC/SSH spawn already carries the pane key.

Presentation is transactional: lookup peeks the retired owner, and the entry is removed
only after provider spawn succeeds (including a successful rebind or shell replacement).
A provider rejection leaves the entry for the next relay incarnation retry; a later
restore after successful rebind cannot see it. A restore with no entry remains `unknown`;
known-different still declines agent resume and known-same still resumes. Concurrent
lookups are serialized by the spawn path, and the map remains bounded at 256 with
recency refresh.

## Tests and verification

Add red-before-fix tests in stable-owner and SSH relay suites: synthetic relay exit records
the exact owner; first provider rejection leaves that owner for a successful retry; success
removes it and blocks replay; an attach/rebind followed by an unrelated restore of the same
pane is unknown; same-epoch, legacy/no-entry, and concurrent presentation controls remain
unchanged. Run focused tests, typecheck, oxlint/format, relay build, then both runtime
scenarios in separate and back-to-back app sessions against `openclaw`.

## OSS precedent

The synced desktop terminal manager keeps killed-session tombstones separate from
live-resource maps, bounds them, refreshes recency on re-record, and consumes them on
matching reuse. It clears the tombstone before create and does not roll it back on
create failure; rollback-on-provider-failure is an Orca requirement demonstrated by
STA-5698, not OSS precedent. This change borrows only separation, bounding, recency,
and explicit reuse.
