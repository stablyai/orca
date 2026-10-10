import { translate } from '@/i18n/i18n'
import { GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION } from '../../../../shared/git-performance-config-plan'
import type {
  GitPerformanceConfigKey,
  GitPerformanceConfigKeyPlan,
  GitPerformanceConfigUnavailableReason
} from '../../../../shared/git-performance-config-types'

export const GIT_PERFORMANCE_CONFIG_SECTION_ID = 'git-performance-config'

export const GIT_PERFORMANCE_CONFIG_KEYWORDS = [
  'performance',
  'tuning',
  'large repository',
  'monorepo',
  'git status',
  'fsmonitor',
  'untracked cache',
  'index version',
  'checkout workers',
  'commit graph'
]

export function getGitPerformanceConfigTitle(): string {
  return translate('auto.components.settings.GitPerformanceConfig.title', 'Git Performance Tuning')
}

export function getGitPerformanceConfigFsmonitorTitle(): string {
  return translate(
    'auto.components.settings.GitPerformanceConfig.fsmonitorTitle',
    'Git File Watcher'
  )
}

export function getGitPerformanceConfigDescription(): string {
  return translate(
    'auto.components.settings.GitPerformanceConfig.description',
    'Recommended sets repository-local Git options that make status, checkout and fetch faster in large repositories. Orca applies them to projects you add from now on, never changes an option you already set, and Off removes only the options Orca added.'
  )
}

export function getGitPerformanceConfigKeyDescription(key: GitPerformanceConfigKey): string {
  switch (key) {
    case 'core.untrackedCache':
      return translate(
        'auto.components.settings.GitPerformanceConfig.keyUntrackedCache',
        'Remembers untracked folders so status skips unchanged ones. Local macOS and Linux disks only.'
      )
    case 'core.fsmonitor':
      return translate(
        'auto.components.settings.GitPerformanceConfig.keyFsmonitorOptIn',
        "Uses Git's built-in file watcher instead of scanning every file. Git 2.37 or newer. Leave it off if an older Git also uses these checkouts, for example in WSL, a container or CI: Git before 2.36 misreads it and misses changes."
      )
    case 'index.version':
      return translate(
        'auto.components.settings.GitPerformanceConfig.keyIndexVersion',
        'Writes a smaller index for new worktrees in repositories with 10,000 or more tracked files.'
      )
    case 'checkout.workers':
      return translate(
        'auto.components.settings.GitPerformanceConfig.keyCheckoutWorkers',
        'Writes files in parallel on checkout and worktree creation. Git 2.32 or newer.'
      )
    case 'fetch.writeCommitGraph':
      return translate(
        'auto.components.settings.GitPerformanceConfig.keyWriteCommitGraph',
        'Updates the commit graph after fetch, which speeds up history and ahead/behind counts.'
      )
  }
}

function describeSkip(
  plan: Extract<GitPerformanceConfigKeyPlan, { action: 'skip' }>
): string | null {
  switch (plan.reason) {
    case 'set-by-user':
    case 'not-opted-in':
      return null
    case 'set-by-feature-many-files':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipManyFiles',
        'covered by feature.manyFiles'
      )
    case 'git-version-unknown':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipVersionUnknown',
        'unknown Git version'
      )
    case 'git-too-old':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipGitTooOld',
        'needs Git {{version}} or newer',
        {
          version: `${GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION[plan.key].major}.${GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION[plan.key].minor}`
        }
      )
    case 'platform':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipPlatform',
        'not used on this operating system'
      )
    case 'filesystem':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipFilesystem',
        'not a local disk Orca can rely on'
      )
    case 'fsmonitor-incompatible':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipFsmonitorIncompatible',
        'Git cannot watch this folder'
      )
    case 'small-repository':
      return translate(
        'auto.components.settings.GitPerformanceConfig.skipSmallRepository',
        'fewer than 10,000 tracked files'
      )
  }
}

export function describeSkippedKeys(plan: readonly GitPerformanceConfigKeyPlan[]): string | null {
  const parts = plan.flatMap((entry) => {
    if (entry.action !== 'skip') {
      return []
    }
    const reason = describeSkip(entry)
    return reason ? [`${entry.key} (${reason})`] : []
  })
  if (parts.length === 0) {
    return null
  }
  return translate(
    'auto.components.settings.GitPerformanceConfig.skipped',
    'Not applied: {{keys}}',
    {
      keys: parts.join(', ')
    }
  )
}

export function describeOrcaKeys(keys: readonly string[]): string {
  return keys.length > 0
    ? translate('auto.components.settings.GitPerformanceConfig.orcaKeys', 'Orca set {{keys}}', {
        keys: keys.join(', ')
      })
    : translate(
        'auto.components.settings.GitPerformanceConfig.noOrcaKeys',
        'No options set by Orca'
      )
}

export function describeUserKeys(keys: readonly string[]): string | null {
  return keys.length > 0
    ? translate(
        'auto.components.settings.GitPerformanceConfig.userKeys',
        'Already set in your Git config: {{keys}}',
        { keys: keys.join(', ') }
      )
    : null
}

export function describeUnavailable(reason: GitPerformanceConfigUnavailableReason): string {
  switch (reason) {
    case 'not-git':
    case 'not-found':
      return translate(
        'auto.components.settings.GitPerformanceConfig.unavailableNotFound',
        'Not a Git repository'
      )
    case 'disabled':
      return translate(
        'auto.components.settings.GitPerformanceConfig.unavailableDisabled',
        'Choose Recommended to apply'
      )
    case 'ssh-disconnected':
      return translate(
        'auto.components.settings.GitPerformanceConfig.unavailableSshDisconnected',
        'Connect the SSH host to check this repository'
      )
    case 'relay-outdated':
      return translate(
        'auto.components.settings.GitPerformanceConfig.unavailableRelayOutdated',
        'Reconnect the SSH host to update Orca there'
      )
    case 'failed':
      return translate(
        'auto.components.settings.GitPerformanceConfig.unavailableFailed',
        'Could not read the Git config'
      )
  }
}
