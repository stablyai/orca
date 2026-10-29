import { z } from 'zod'
import { RepoSelector } from './github-repo-target-params'

const name = z.string().trim().min(1).max(255)
export const GitHubParticipantAccount = z.object({ host: name, user: name }).strict()
export const GitHubParticipantStatus = RepoSelector.strict()
export const GitHubParticipantSave = RepoSelector.extend({
  id: name.optional(),
  name,
  deviceIds: z.array(name).max(100),
  allowedAccounts: z.array(GitHubParticipantAccount).max(100)
}).strict()
export const GitHubParticipantRemove = RepoSelector.extend({ id: name }).strict()
export const GitHubParticipantMode = RepoSelector.extend({ enabled: z.boolean() }).strict()
export const GitHubParticipantSelect = RepoSelector.extend({
  account: GitHubParticipantAccount.nullable()
}).strict()
