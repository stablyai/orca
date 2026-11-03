import type { GhAccountBinding } from './account-binding'

export const GITHUB_PARTICIPANT_ACCOUNTS_CAPABILITY = 'github-participant-accounts-v1'

export type GitHubParticipant = {
  id: string
  name: string
  deviceIds: string[]
  allowedAccounts: GhAccountBinding[]
}

export type GitHubParticipantSelection = Readonly<{
  participantId: string
  account: Readonly<GhAccountBinding>
}>

export type GitHubParticipantSelfStatus = {
  enabled: boolean
  participantId?: string
  participantName?: string
  allowedAccounts: GhAccountBinding[]
  selectedAccount?: GhAccountBinding
}

export type GitHubParticipantSettingsStatus = GitHubParticipantSelfStatus & {
  isOwner: boolean
  participants?: GitHubParticipant[]
  devices?: { deviceId: string; name: string }[]
  error?: string
}
