// What the composer card needs for Orca Cloud, shared by the hook and the card. Picking Orca Cloud
// changes nothing else in the dialog (composer-redo): setup lives on its own page after Start.
import type { CloudOnlyRepo } from './use-cloud-only-repo'
import type { OrcaCloudWallNotice } from '@/lib/orca-cloud/run-on-preflight'

export type CloudStartView = {
  /** Picks Orca Cloud even while the account still needs setup; Start walks it on a page. */
  onSelectOrcaCloud: () => void
  onUserPick: () => void
  /** D4: GitHub repositories with no clone here, and the one picked. */
  cloudOnly?: CloudOnlyRepo
  /** The project is a plain folder: Orca Cloud needs a GitHub repository instead (D3/D4). */
  folderProject?: boolean
  /** JA-21b (flagged): Orca Cloud is selected and a billing wall applies; Create waits for the fix. */
  wall?: OrcaCloudWallNotice | null
  /**
   * RR-c1: Orca Cloud is selected but the project is a plain folder. Both selections stay and Create
   * stays enabled; Create (button or ⌘↵) then stops before submitting and this error shows under
   * Project. `hasRepos`: any to choose from. `attempt` counts those stopped Creates (focus moves to
   * Project on each); absent until the first.
   */
  needsGitHubRepo?: { hasRepos: boolean; attempt?: number } | null
}

/**
 * RR-c1: Orca Cloud on a plain folder, with no GitHub repository picked yet: Create waits.
 * `hasRepos` (the "Choose repository" link) whenever the Project picker can offer one: a GitHub
 * repository with no clone here, or a GitHub-backed project already added (design-squad).
 */
export function orcaCloudNeedsGitHubRepo(args: {
  cloudSelected: boolean
  folderProject: boolean
  pickedRepo: boolean
  repoCount: number
  githubProjectCount: number
}): { hasRepos: boolean } | null {
  return args.cloudSelected && args.folderProject && !args.pickedRepo
    ? { hasRepos: args.repoCount > 0 || args.githubProjectCount > 0 }
    : null
}

/** A project that can start in Orca Cloud: git, with a GitHub remote (or one not read yet). */
export function isGitHubBackedProject(repo: {
  kind?: string
  gitRemoteIdentity?: { remoteUrl: string } | null
}): boolean {
  if (repo.kind === 'folder') {
    return false
  }
  const url = repo.gitRemoteIdentity?.remoteUrl
  return !url || /(^|[@/.])github\.com[:/]/i.test(url)
}

/** The line under Project that explains why Create waits; Create's aria-describedby points here. */
export const ORCA_CLOUD_NEEDS_REPO_ID = 'orca-cloud-needs-github-repo'

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
