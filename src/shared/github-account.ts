// Types for the GitHub account panel: in-app sign-in (device flow or PAT),
// the authenticated user's repository list, and clone-into-Orca handoff.
// The token itself never crosses IPC — only status metadata and results.

import type { Repo } from './repo-types'

export type GitHubAccountAuthMethod = 'device-flow' | 'pat'

// Where the active credential comes from. Drives whether the UI offers
// Disconnect, which is only meaningful for in-app `stored` credentials.
export type GitHubAccountCredentialSource = 'environment' | 'stored' | 'none'

// Deliberately excludes the token: it never crosses the IPC boundary back to
// the renderer.
export type GitHubAccountStatus = {
  configured: boolean
  source: GitHubAccountCredentialSource
  login: string | null
  name: string | null
  avatarUrl: string | null
  authMethod: GitHubAccountAuthMethod | null
  /** True when an OAuth client id is configured, so the panel can offer device flow. */
  deviceFlowAvailable: boolean
}

export type GitHubConnectTokenResult =
  | { ok: true; login: string | null }
  | { ok: false; error: string }

export type GitHubDeviceFlowStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  pollIntervalSeconds: number
}

export type GitHubDeviceFlowStartResult =
  | { ok: true; flow: GitHubDeviceFlowStart }
  | { ok: false; error: string }

export type GitHubDeviceFlowPollResult =
  | { status: 'pending'; pollIntervalSeconds?: number }
  | { status: 'connected'; login: string | null }
  | { status: 'error'; error: string }

export type GitHubAccountRepo = {
  id: number
  name: string
  fullName: string
  description: string | null
  isPrivate: boolean
  isFork: boolean
  htmlUrl: string
  cloneUrl: string
  sshUrl: string
  defaultBranch: string
  language: string | null
  stargazersCount: number
  pushedAt: string | null
  ownerLogin: string
  ownerAvatarUrl: string | null
}

export type GitHubRepoListResult =
  | { ok: true; repos: GitHubAccountRepo[] }
  | { ok: false; error: string }

export type GitHubCloneRepoArgs = {
  fullName: string
  cloneUrl: string
  isPrivate: boolean
  destination: string
}

export type GitHubCloneRepoResult = { ok: true; repo: Repo } | { ok: false; error: string }

export type GitHubDeleteClonedRepoFilesResult = { ok: true } | { ok: false; error: string }
