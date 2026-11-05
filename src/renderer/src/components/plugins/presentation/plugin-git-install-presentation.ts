import { translate } from '@/i18n/i18n'
import type { PluginGitInstallInputError } from '../../../../../shared/plugins/installation/plugin-git-install-input'
import type {
  PluginGitResolution,
  PluginGitSourceResolution
} from '../../../../../shared/plugins/installation/plugin-git-resolution'

export function pluginGitInputErrorMessage(reason: PluginGitInstallInputError): string {
  switch (reason) {
    case 'missing-git-url':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitUrlRequired',
        'Enter a repository URL.'
      )
    case 'git-url-credentials':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitUrlCredentials',
        'Remove the username or token from the URL. Orca uses your Git sign-in.'
      )
    case 'invalid-git-ref':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitRefInvalid',
        "The version after # isn't a valid tag, branch, or commit name."
      )
    case 'invalid-git-url':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitUrlInvalid',
        'Use a repository link like https://github.com/owner/repo, owner/repo, or an SSH URL.'
      )
  }
}

export function pluginGitResolutionErrorMessage(
  resolution: Exclude<PluginGitSourceResolution, { ok: true }>
): string {
  return resolution.reason === 'ref-not-found'
    ? translate(
        'auto.components.settings.PluginInstallDialog.gitRefNotFound',
        'This repository has no tag or branch named {{value0}}.',
        { value0: resolution.ref }
      )
    : translate(
        'auto.components.settings.PluginInstallDialog.gitUnreachable',
        "Couldn't read this repository. Check the URL and that your Git account can access it."
      )
}

export function pluginGitResolutionSummary(resolution: PluginGitResolution): string {
  const commit = resolution.commit.slice(0, 7)
  switch (resolution.kind) {
    case 'latest-tag':
      return translate(
        'auto.components.settings.PluginInstallDialog.resolvedLatestTag',
        'Installs {{value0}}, the latest version, at commit {{value1}}.',
        { value0: resolution.ref, value1: commit }
      )
    case 'tag':
      return translate(
        'auto.components.settings.PluginInstallDialog.resolvedTag',
        'Installs {{value0}} at commit {{value1}}.',
        { value0: resolution.ref, value1: commit }
      )
    case 'branch':
      return translate(
        'auto.components.settings.PluginInstallDialog.resolvedBranch',
        'Installs branch {{value0}} as it is now, at commit {{value1}}.',
        { value0: resolution.ref, value1: commit }
      )
    case 'commit':
      return translate(
        'auto.components.settings.PluginInstallDialog.resolvedCommit',
        'Installs commit {{value0}}.',
        { value0: commit }
      )
    case 'default-branch':
      return translate(
        'auto.components.settings.PluginInstallDialog.resolvedDefaultBranch',
        'No version tag found, so this installs the latest commit, {{value0}}.',
        { value0: commit }
      )
  }
}
