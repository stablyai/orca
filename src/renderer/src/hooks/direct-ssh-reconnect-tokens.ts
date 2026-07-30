import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationToken,
  DirectSshSnapshotApplyToken
} from './direct-ssh-reconnect-coordinator-types'

export function directSshAuthoritiesEqual(
  left: DirectSshAuthority | null | undefined,
  right: DirectSshAuthority | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

export function normalizeDirectSshPreparationInput(
  input: DirectSshPreparationInput
): DirectSshPreparationInput {
  return {
    ...input,
    repoRefs: [...input.repoRefs].sort(
      (left, right) =>
        compareText(left.executionHostId, right.executionHostId) ||
        compareText(left.repoId, right.repoId)
    )
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isDirectSshPreparationInputHostConsistent(
  input: DirectSshPreparationInput
): boolean {
  const expectedHost = toSshExecutionHostId(input.targetId)
  return input.repoRefs.every((repo) => repo.executionHostId === expectedHost)
}

export function directSshRepoFingerprint(input: DirectSshPreparationInput): string {
  return JSON.stringify(input.repoRefs.map((repo) => [repo.executionHostId, repo.repoId]))
}

export function directSshPreparationOperationKey(input: DirectSshPreparationInput): string {
  return JSON.stringify([
    input.targetId,
    input.providerEpoch,
    input.connectionGeneration,
    input.catalogRevision,
    directSshRepoFingerprint(input),
    input.authorityRequirement,
    input.snapshotRevision ?? null,
    input.reason
  ])
}

export function buildDirectSshSnapshotApplyToken(
  token: DirectSshPreparationToken,
  snapshotRevision: number
): DirectSshSnapshotApplyToken | null {
  if (token.snapshotRevision !== null && token.snapshotRevision !== snapshotRevision) {
    return null
  }
  return { ...token, snapshotRevision }
}

export function admitDirectSshSnapshotApplyToken(
  token: DirectSshSnapshotApplyToken,
  authority: DirectSshAuthority,
  snapshotRevision: number
): boolean {
  return (
    token.snapshotRevision === snapshotRevision &&
    directSshAuthoritiesEqual(token.authority, authority)
  )
}
