import type { SshRepoReadoption, SshTarget, SshTargetSummary } from './ssh-types'

// Old hosts lack SSH management RPCs; disable server management rather than editing the client’s own hosts.
export const SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY = 'ssh.target-management.v1' as const

/** Paired-client editable fields; exclude passwords/passphrases because the server prompts instead of storing them. */
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
  'systemSshProxyConnectionReuse',
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
