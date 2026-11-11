import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'

export type PreflightIssue = {
  id: string
  title: string
  description: string
  fixLabel: string
  fixUrl: string
  /** Git is required globally; provider CLI setup nudges remain dismissible. */
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
  options: LandingPreflightIssueOptions,
  t: Translate = translate
): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  if (!status.git.installed) {
    issues.push({
      id: 'git',
      title: t('auto.components.Landing.e5b7296d9d', 'Git is not installed'),
      description: t(
        'auto.components.Landing.b673e7cf1b',
        'Git is required for Git projects, source control, and workspace management.'
      ),
      fixLabel: t('auto.components.Landing.installGit', 'Install Git'),
      fixUrl: 'https://git-scm.com/downloads'
    })
  }

  // Only nudge GitHub CLI setup when a GitHub-backed project can use it.
  if (!options.hasGitHubBackedProject) {
    return issues
  }

  if (!status.gh.installed) {
    issues.push({
      id: 'gh',
      title: t('auto.components.Landing.5beaef5f9e', 'GitHub CLI is not installed'),
      description: t(
        'auto.components.Landing.73e1ad4282',
        'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.'
      ),
      fixLabel: t('auto.components.Landing.installGitHubCli', 'Install GitHub CLI'),
      fixUrl: 'https://cli.github.com',
      dismissible: true
    })
  } else if (!status.gh.authenticated) {
    issues.push({
      id: 'gh-auth',
      title: t('auto.components.Landing.9f96d018b7', 'GitHub CLI is not authenticated'),
      description: t(
        'auto.components.Landing.00cee697c1',
        'Run "gh auth login" in a terminal to connect your GitHub account.'
      ),
      fixLabel: t('auto.components.Landing.learnMore', 'Learn more'),
      fixUrl: 'https://cli.github.com/manual/gh_auth_login',
      dismissible: true
    })
  }

  return issues
}
