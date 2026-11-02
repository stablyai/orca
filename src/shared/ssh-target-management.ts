import type { SshRepoReadoption, SshTarget, SshTargetSummary } from './ssh-types'

// Why: hosts without this have no ssh.listEditableTargets/addTarget/updateTarget/removeTarget/
// browseDir or repo.addRemote. A client must disable server SSH management, never manage its own
// SSH hosts in their place.
export const SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY = 'ssh.target-management.v1' as const

/**
 * The SSH target fields a paired client reads and writes on a server. There is deliberately no
 * password or key passphrase: the server stores none and asks for them when it connects.
 */
export const SSH_EDITABLE_TARGET_FIELDS = [
  'label',
  'configHost',
  'host',
  'port',
  'username',
  'identityFile',
  'identityAgent',
  'identitiesOnly',
  'gssapiAuthentication',
  'proxyCommand',
  'jumpHost',
  'relayGracePeriodSeconds',
  'systemSshConnectionReuse',
  'remoteRuntime',
  'allowRemoteCliControl'
] as const satisfies readonly (keyof SshTarget)[]

export type SshEditableTargetField = (typeof SSH_EDITABLE_TARGET_FIELDS)[number]

/** What a client sends to add a target or to replace an existing target's editable fields. */
export type SshEditableTargetInput = Pick<SshTarget, 'label' | 'host' | 'port' | 'username'> &
  Partial<Pick<SshTarget, Exclude<SshEditableTargetField, 'label' | 'host' | 'port' | 'username'>>>

export type SshEditableTarget = SshTargetSummary &
  SshEditableTargetInput & {
    source?: SshTarget['source']
    /** The host serves a managed Orca server; it can be edited but not removed from here. */
    managedServer?: true
  }

export type SshEditableTargetAddResult = {
  target: SshEditableTarget
  repoReadoptions: SshRepoReadoption[]
}
