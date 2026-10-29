import type { GhAccountBinding } from './account-binding'

/** Host-assigned snapshot for accepted work; never trusted from client parameters. */
export type GitHubExecutionIdentity = Readonly<{
  repoId: string
  participantId: string
  account: Readonly<GhAccountBinding>
}>
