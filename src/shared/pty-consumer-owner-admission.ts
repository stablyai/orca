import {
  PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR,
  PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR,
  PTY_CONSUMER_OWNER_HELD_GRACE_FLOOR_MS,
  PTY_CONSUMER_OWNER_HELD_SELF_ERROR,
  type PtyConsumerCloseCause,
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR
} from './pty-consumer-session-contract'

type HeldOwner = {
  state: 'pending' | 'active' | 'disconnected'
  disconnectedAt?: number
  disconnectCause?: PtyConsumerCloseCause
}

export type RefuseHeldPtyConsumerOwnerOptions = {
  ownerGraceMs: number
  now: number
  sameClient: boolean
  // Why a callback instead of mutating the record: the owner record is reachable from `replaces`
  // chains and from displaced-owner snapshots already handed to callers. Clamping in place would
  // rewrite those retroactively, so the session that owns the record applies it copy-on-write.
  clampGraceTo: (disconnectedAt: number) => void
}

function refuse(message: string, code: number): never {
  throw Object.assign(new Error(message), { code })
}

/**
 * Why an owner-capable request is refused rather than demoted: a subscriber grant is unusable to a
 * client that needs to drive the PTY, and it arrives shaped like success. A coded refusal lets the
 * caller retry the transient case and stop on the blocked one.
 */
export function refuseHeldPtyConsumerOwner(
  owner: Readonly<HeldOwner>,
  options: RefuseHeldPtyConsumerOwnerOptions
): never {
  if (owner.state === 'pending') {
    refuse('Owner grant publication is still pending', PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR)
  }
  if (owner.state === 'active') {
    // Why identity without the lease: a client that lost its proof — a fresh process, a dropped
    // recovery record — still knows who it is. Against an incumbent carrying its own instance id
    // the honest answer is "your other connection is still registered", which resolves itself once
    // the relay notices that socket. Blocking here strands the single-app case forever.
    if (options.sameClient) {
      refuse(
        "PTY session owner is held by this client's own earlier connection",
        PTY_CONSUMER_OWNER_HELD_SELF_ERROR
      )
    }
    refuse(
      'PTY session owner is held by an attached connection',
      PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR
    )
  }
  clampDisconnectedOwnerGrace(owner, options)
  refuse(
    'PTY session owner is held by a disconnected connection within its grace period',
    PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR
  )
}

// Why only a peer-closed disconnect may shorten this: the floor is a bet that the incumbent is gone,
// and the relay tears a client's socket down for its own reasons too — a full lane queue is the
// signature of an owner that is alive but not draining fast enough. No owner completes a reconnect
// ladder in 250 ms, so clamping on a teardown we initiated hands a live owner's admission away and
// it can never get it back. Expiring a record never stops the remote PTY, but it does cost the user
// every route back to it.
function clampDisconnectedOwnerGrace(
  owner: Readonly<HeldOwner>,
  options: RefuseHeldPtyConsumerOwnerOptions
): void {
  if (owner.disconnectCause !== 'peer-closed') {
    return
  }
  const floorStart =
    options.now - Math.max(options.ownerGraceMs - PTY_CONSUMER_OWNER_HELD_GRACE_FLOOR_MS, 0)
  if ((owner.disconnectedAt ?? 0) <= floorStart) {
    return
  }
  options.clampGraceTo(floorStart)
}
