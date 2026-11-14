// Keep GHES host identity across renderer/RPC boundaries to prevent actions targeting same-named github.com repos.
export type GitHubRepositoryIdentity = { owner: string; repo: string; host?: string }
