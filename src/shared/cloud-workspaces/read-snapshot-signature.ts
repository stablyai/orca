// Who wrote a read snapshot. The VM signs every snapshot with its own Ed25519 key (created once on
// the VM's disk, never leaving it), so a device that has seen this workspace's key before refuses a
// snapshot the control plane made up or swapped in, even though it can seal to any reader key.
//
// Signed message (keep in sync with image/vm/orca-read-snapshot.cjs):
//   utf8 "orca-cloud-read-sig-v1:" + workspaceId + ":" + snapshotId + ":" + nonceB64 + ":"
//   followed by the raw ciphertext bytes (body ct || tag). capturedAt is inside the ciphertext, so
//   the signature covers it as well.
//
// Trust: a device pins the workspace's signer the first time it sees it, from the sealed grant it
// pairs with or from its first snapshot (trust on first use, the same root as pairing itself), and
// from then on accepts only that signer, and never a copy older than one it already showed.
import { base64ToBytes } from './sealed-grant'

export const READ_SNAPSHOT_SIG_INFO = 'orca-cloud-read-sig-v1'

export type Ed25519Verify = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
) => boolean | Promise<boolean>

type SignedFields = {
  workspaceId: string
  snapshotId: string
  nonceB64: string
  ciphertextB64: string
  signature?: { publicKeyB64: string; signatureB64: string }
}

export function readSnapshotSignedMessage(sealed: SignedFields): Uint8Array {
  const head = new TextEncoder().encode(
    `${READ_SNAPSHOT_SIG_INFO}:${sealed.workspaceId}:${sealed.snapshotId}:${sealed.nonceB64}:`
  )
  const body = base64ToBytes(sealed.ciphertextB64)
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

/** The signer's public key when the signature verifies; null when unsigned; throws when forged. */
export async function verifyReadSnapshotSigner(
  sealed: SignedFields,
  verify: Ed25519Verify
): Promise<string | null> {
  if (!sealed.signature) {
    return null
  }
  let ok = false
  try {
    const publicKey = base64ToBytes(sealed.signature.publicKeyB64)
    const signature = base64ToBytes(sealed.signature.signatureB64)
    ok =
      publicKey.length === 32 &&
      signature.length === 64 &&
      (await verify(publicKey, readSnapshotSignedMessage(sealed), signature))
  } catch {
    ok = false
  }
  if (!ok) {
    throw new ReadSnapshotSignatureError('bad_signature')
  }
  return sealed.signature.publicKeyB64
}

export class ReadSnapshotSignatureError extends Error {
  constructor(readonly code: 'bad_signature') {
    super(code)
    this.name = 'ReadSnapshotSignatureError'
  }
}

/** What a device remembers per workspace (persisted; nothing secret in it). */
export type ReadSnapshotPin = {
  /** The VM signer first seen for this workspace; null until one is seen. */
  signerPublicKeyB64: string | null
  /** The newest capturedAt shown on this device. */
  newestCapturedAt: number
}

export type ReadSnapshotPinVerdict =
  | { ok: true; pin: ReadSnapshotPin }
  | { ok: false; reason: 'rollback' | 'signer_changed' | 'unsigned' }

/**
 * Decides whether a verified snapshot may be shown, and the pin to keep if so. `signer` is the
 * result of verifyReadSnapshotSigner. An unsigned copy is accepted only while no signer is pinned
 * (VMs from before signing); after that, only the pinned signer, and never an older capture.
 */
export function checkReadSnapshotPin(
  pin: ReadSnapshotPin | null,
  signer: string | null,
  capturedAt: number
): ReadSnapshotPinVerdict {
  const pinned = pin?.signerPublicKeyB64 ?? null
  if (pinned !== null && signer === null) {
    return { ok: false, reason: 'unsigned' }
  }
  if (pinned !== null && signer !== pinned) {
    return { ok: false, reason: 'signer_changed' }
  }
  if (pin && capturedAt < pin.newestCapturedAt) {
    return { ok: false, reason: 'rollback' }
  }
  return {
    ok: true,
    pin: {
      signerPublicKeyB64: pinned ?? signer,
      newestCapturedAt: Math.max(capturedAt, pin?.newestCapturedAt ?? 0)
    }
  }
}

/**
 * A sealed grant (the pairing path) can carry the signer too. Opening a grant only fills an empty
 * pin: a grant is relayed by the control plane like a snapshot, so on its own it never replaces a
 * signer already pinned.
 */
export function pinFromGrant(
  pin: ReadSnapshotPin | null,
  signerPublicKeyB64: string
): ReadSnapshotPin {
  if (pin?.signerPublicKeyB64) {
    return pin
  }
  return { signerPublicKeyB64, newestCapturedAt: pin?.newestCapturedAt ?? 0 }
}

/**
 * The grant's pairing then succeeded: this device completed the end-to-end encrypted handshake
 * with the workspace's orcad using that grant's offer. Only then may its signer replace a pinned
 * one (the VM's disk was replaced and the person woke it). There is no "trust anyway" path.
 */
export function repinAfterPairing(
  pin: ReadSnapshotPin | null,
  signerPublicKeyB64: string
): ReadSnapshotPin {
  return { signerPublicKeyB64, newestCapturedAt: pin?.newestCapturedAt ?? 0 }
}

/**
 * Store-side merge for a verdict, applied atomically against what is stored *now*: the floor only
 * moves forward, and the signer changes only if the stored pin still has the signer the verdict was
 * checked against (a concurrent grant pin or forget wins over a stale read).
 */
export function mergeReadSnapshotPin(
  stored: ReadSnapshotPin | null,
  checkedAgainst: ReadSnapshotPin | null,
  next: ReadSnapshotPin
): ReadSnapshotPin {
  const storedSigner = stored?.signerPublicKeyB64 ?? null
  const signer =
    storedSigner === (checkedAgainst?.signerPublicKeyB64 ?? null)
      ? next.signerPublicKeyB64
      : storedSigner
  return {
    signerPublicKeyB64: signer,
    newestCapturedAt: Math.max(stored?.newestCapturedAt ?? 0, next.newestCapturedAt)
  }
}
