import { stripCredentialsFromMessage } from '../../../../shared/git-remote-error'
import type { GitRemoteIdentity } from '../../../../shared/git-remote-identity'
import { getAncestorProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import type { ProjectProviderIdentity } from '../../../../shared/project-types'
import { PROJECT_HOST_SETUP_CHECKOUT_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '../../runtime/runtime-rpc-client'

/**
 * The value as a trimmed string, or empty for anything else: a persisted row, or a peer on another
 * version, can deliver a non-string where the type promises one, and `.trim()` on it would throw
 * before any fallback could run.
 */
function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The selected project's remote identity as it should travel to another host with a setup request:
 * embedded credentials stripped, and dropped entirely when a row (persisted JSON, or a peer on a
 * different version) is missing a part the receiver requires — sending a blank would fail the whole
 * request's validation instead of letting it fall back to the provider identity.
 */
export function redactProjectGitRemoteIdentityForTransfer(
  identity: GitRemoteIdentity | undefined
): GitRemoteIdentity | undefined {
  if (!identity) {
    return undefined
  }
  const canonicalKey = trimmedString(identity.canonicalKey)
  const remoteName = trimmedString(identity.remoteName)
  const remoteUrl = stripCredentialsFromMessage(trimmedString(identity.remoteUrl))
  if (!canonicalKey || !remoteName || !remoteUrl) {
    return undefined
  }
  const originCanonicalKey = trimmedString(identity.origin?.canonicalKey)
  const originRemoteUrl = stripCredentialsFromMessage(trimmedString(identity.origin?.remoteUrl))
  return {
    canonicalKey,
    remoteName,
    remoteUrl,
    ...(originCanonicalKey && originRemoteUrl
      ? { origin: { canonicalKey: originCanonicalKey, remoteUrl: originRemoteUrl } }
      : {})
  }
}

export const CHECKOUT_IDENTITY_HOST_UPDATE_REQUIRED_MESSAGE =
  'The selected Orca server is too old to set this project up: it identifies a checkout by the repository it was forked or generated from. Update Orca on the server and try again.'

/**
 * The identity a setup request should carry to `target`.
 *
 * A host that predates `project-host-setup.checkout-identity.v1` aligns an existing folder only
 * through the provider identity and drops the unknown checkout field, so it cannot honour a project
 * id derived from the checkout's own remote. Substituting the ancestor-derived id would "succeed"
 * by adding the host to the fork parent or template instead of the project the user picked, so this
 * refuses instead — and only for the fork/template projects whose ids actually differ.
 */
export async function negotiateProjectSetupIdentity(input: {
  target: RuntimeClientTarget
  projectId: string
  providerIdentity: ProjectProviderIdentity | undefined
  gitRemoteIdentity: GitRemoteIdentity | undefined
}): Promise<{
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  projectGitRemoteIdentity?: GitRemoteIdentity
}> {
  const projectGitRemoteIdentity = redactProjectGitRemoteIdentityForTransfer(
    input.gitRemoteIdentity
  )
  // Why compare with the id the old host derives, not with "has a provider identity": a plain
  // GitLab repo or a folder project keys identically on both sides and must not be refused.
  const ancestorId = getAncestorProjectIdentityKey({
    ...(input.providerIdentity
      ? {
          upstream: {
            owner: input.providerIdentity.owner,
            repo: input.providerIdentity.repo,
            ...(input.providerIdentity.host ? { host: input.providerIdentity.host } : {})
          }
        }
      : {}),
    gitRemoteIdentity: input.gitRemoteIdentity
  })
  const needsCheckoutIdentity = ancestorId !== null && ancestorId !== input.projectId
  if (
    needsCheckoutIdentity &&
    input.target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      input.target.environmentId,
      PROJECT_HOST_SETUP_CHECKOUT_IDENTITY_RUNTIME_CAPABILITY,
      15_000
    ))
  ) {
    throw new Error(CHECKOUT_IDENTITY_HOST_UPDATE_REQUIRED_MESSAGE)
  }
  return {
    projectId: input.projectId,
    ...(input.providerIdentity ? { projectProviderIdentity: input.providerIdentity } : {}),
    ...(projectGitRemoteIdentity ? { projectGitRemoteIdentity } : {})
  }
}
