import type { GhAccountBinding } from './accounts/account-binding'

/** Host-assigned snapshot for accepted work; never trusted from client parameters. */
export type GitHubExecutionIdentity = Readonly<{
  repoId: string
  participantId: string
  account: Readonly<GhAccountBinding>
}>
