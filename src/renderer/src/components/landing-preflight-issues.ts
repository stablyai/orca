import { translate } from '@/i18n/i18n'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/types'

export type PreflightIssue = {
  id: string
  title: string
  description: string
  fixLabel: string
  fixUrl: string
  /** Git is a hard global dependency and stays pinned; provider-specific CLI
   *  setup is a soft nudge the user can dismiss. */
  dismissible?: boolean
}

export type LandingPreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

export type LandingPreflightIssueOptions = {
  hasGitHubBackedProject: boolean
}

export function hasGitHubBackedProject(repos: readonly Repo[]): boolean {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return projection.projects.some((project) => project.providerIdentity?.provider === 'github')
}

export function getLandingPreflightIssues(
  status: LandingPreflightStatus,
  options: LandingPreflightIssueOptions
): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  if (!status.git.installed) {
    issues.push({
      id: 'git',
      title: translate('auto.components.Landing.e5b7296d9d', 'Git is not installed'),
      description: translate(
        'auto.components.Landing.b673e7cf1b',
        'Git is required for Git projects, source control, and workspace management.'
      ),
      fixLabel: 'Install Git',
      fixUrl: 'https://git-scm.com/downloads'
    })
  }

  // Why: gh only powers GitHub PRs/issues/checks; GitLab-only projects should
  // not see GitHub setup pressure on the landing screen.
  if (!options.hasGitHubBackedProject) {
    return issues
  }

  if (!status.gh.installed) {
    issues.push({
      id: 'gh',
      title: translate('auto.components.Landing.5beaef5f9e', 'GitHub CLI is not installed'),
      description: translate(
        'auto.components.Landing.73e1ad4282',
        'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.'
      ),
      fixLabel: 'Install GitHub CLI',
      fixUrl: 'https://cli.github.com',
      dismissible: true
    })
  } else if (!status.gh.authenticated) {
    issues.push({
      id: 'gh-auth',
      title: translate('auto.components.Landing.9f96d018b7', 'GitHub CLI is not authenticated'),
      description: translate(
        'auto.components.Landing.00cee697c1',
        'Run "gh auth login" in a terminal to connect your GitHub account.'
      ),
      fixLabel: 'Learn more',
      fixUrl: 'https://cli.github.com/manual/gh_auth_login',
      dismissible: true
    })
  }

  return issues
}
