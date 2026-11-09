import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  EnvironmentBuildStatus,
  EnvironmentBuildStep,
  EnvironmentStaleness
} from './cloud-environment-types'

/** `https://github.com/o/r.git` → `o/r`; anything unrecognised is returned unchanged. */
export function repoDisplayName(url: string): string {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : url
}

const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/**
 * Accepts `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
 * and returns the canonical `owner/repo` the control plane accepts, or null.
 */
export function normalizeRepoInput(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (OWNER_REPO.test(trimmed)) {
    return trimmed.replace(/\.git$/, '')
  }
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/.*)?$/i.exec(
      trimmed
    ) ?? /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  const candidate = `${match[1]}/${match[2]}`
  return OWNER_REPO.test(candidate) ? candidate : null
}

/** Same repo regardless of URL spelling or case. */
export function repoKey(urlOrSlug: string): string {
  return (normalizeRepoInput(urlOrSlug) ?? repoDisplayName(urlOrSlug)).toLowerCase()
}

export type StalenessBannerCopy = {
  tone: 'prominent' | 'info' | 'subtle'
  message: string
  /** Offer the Rebuild action inline. */
  rebuild: boolean
}

export function stalenessBannerCopy(
  staleness: EnvironmentStaleness | null,
  activeBuildNumber: number | null,
  t: Translate = translate
): StalenessBannerCopy | null {
  if (!staleness || activeBuildNumber === null) {
    return null
  }
  const number = String(activeBuildNumber)
  if (staleness.recommendation === 'deps_changed') {
    const repo = staleness.repos.find((entry) => entry.lockfilesChanged.length > 0)
    if (repo) {
      return {
        tone: 'prominent',
        rebuild: true,
        message: t(
          'cloudEnvironment.staleness.depsChanged',
          'Dependencies changed in {{repo}} ({{files}}) since build #{{number}}',
          {
            repo: repoDisplayName(repo.url),
            files: repo.lockfilesChanged.join(', '),
            number
          }
        )
      }
    }
    return {
      tone: 'prominent',
      rebuild: true,
      message: t(
        'cloudEnvironment.staleness.depsChangedGeneric',
        'Dependencies changed since build #{{number}}',
        { number }
      )
    }
  }
  if (staleness.recommendation === 'config_changed') {
    return {
      tone: 'info',
      rebuild: true,
      message: t(
        'cloudEnvironment.staleness.configChanged',
        'You changed the environment since build #{{number}}',
        { number }
      )
    }
  }
  // Orca's base image moved on: lowest priority, so it also backs up an up_to_date/unknown verdict.
  const imageUpdated =
    staleness.recommendation === 'image_updated' || staleness.imageUpdated === true
  if (staleness.recommendation === 'image_updated') {
    return imageUpdatedCopy(number, t)
  }
  if (staleness.recommendation === 'branch_moved') {
    const repo = staleness.repos.find((entry) => (entry.aheadBy ?? 0) > 0)
    if (!repo) {
      return null
    }
    const values = {
      branch: repo.branch ?? 'HEAD',
      repo: repoDisplayName(repo.url),
      count: repo.aheadBy ?? 0,
      number
    }
    return {
      tone: 'subtle',
      rebuild: false,
      // i18next plurals (`_one` / `_other` in the catalog) pick "commit" vs "commits".
      message:
        staleness.repos.length > 1
          ? t(
              'cloudEnvironment.staleness.branchMovedInRepo',
              '{{branch}} in {{repo}} is {{count}} commits ahead of build #{{number}}',
              {
                ...values,
                count: values.count,
                defaultValue_one:
                  '{{branch}} in {{repo}} is {{count}} commit ahead of build #{{number}}'
              }
            )
          : t(
              'cloudEnvironment.staleness.branchMoved',
              '{{branch}} is {{count}} commits ahead of build #{{number}}',
              {
                ...values,
                count: values.count,
                defaultValue_one: '{{branch}} is {{count}} commit ahead of build #{{number}}'
              }
            )
    }
  }
  return imageUpdated ? imageUpdatedCopy(number, t) : null
}

function imageUpdatedCopy(number: string, t: Translate): StalenessBannerCopy {
  return {
    tone: 'subtle',
    rebuild: true,
    message: t(
      'cloudEnvironment.staleness.imageUpdated',
      'Orca’s base image was updated since build #{{number}} — rebuild to pick it up',
      { number }
    )
  }
}

export function stepLabel(step: EnvironmentBuildStep, t: Translate = translate): string {
  switch (step) {
    case 'boot':
      return t('cloudEnvironment.step.boot', 'Start sandbox')
    case 'clone':
      return t('cloudEnvironment.step.clone', 'Clone repositories')
    case 'install':
      return t('cloudEnvironment.step.install', 'Run install script')
    case 'record':
      return t('cloudEnvironment.step.record', 'Record environment')
    case 'snapshot':
      return t('cloudEnvironment.step.snapshot', 'Save snapshot')
  }
}

export function buildStatusLabel(status: EnvironmentBuildStatus, t: Translate = translate): string {
  switch (status) {
    case 'starting':
      return t('cloudEnvironment.status.starting', 'Starting')
    case 'running':
      return t('cloudEnvironment.status.running', 'Building')
    case 'snapshotting':
      return t('cloudEnvironment.status.snapshotting', 'Saving snapshot')
    case 'succeeded':
      return t('cloudEnvironment.status.succeeded', 'Ready')
    case 'failed':
      return t('cloudEnvironment.status.failed', 'Failed')
    case 'canceled':
      return t('cloudEnvironment.status.canceled', 'Canceled')
  }
}

export function isBuildInProgress(status: EnvironmentBuildStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'snapshotting'
}

/** The control plane's error code, in words a person can act on. */
export function buildErrorCopy(error: string | null, t: Translate = translate): string | null {
  if (!error) {
    return null
  }
  const exit = /^exit_(\d+)$/.exec(error)
  if (exit) {
    return t(
      'cloudEnvironment.error.scriptFailed',
      'The install script stopped at a failing command.'
    )
  }
  const provider = /^provider_(\d+)$/.exec(error)
  if (provider) {
    return t(
      'cloudEnvironment.error.provider',
      'Orca Cloud couldn’t start a sandbox. Try again in a few minutes.'
    )
  }
  switch (error) {
    case 'install_failed':
      return t(
        'cloudEnvironment.error.scriptFailed',
        'The install script stopped at a failing command.'
      )
    case 'clone_failed':
      return t(
        'cloudEnvironment.error.cloneFailedPlain',
        'A repository couldn’t be cloned. Check that the Orca GitHub app can access it and the branch exists.'
      )
    case 'record_failed':
      return t(
        'cloudEnvironment.error.recordFailedPlain',
        'Orca couldn’t record the installed environment.'
      )
    case 'timeout':
      return t('cloudEnvironment.error.timeout', 'The build ran past its time limit.')
    case 'snapshot_failed':
      return t('cloudEnvironment.error.snapshotFailed', 'Saving the snapshot failed.')
    case 'runtime_removed':
      return t(
        'cloudEnvironment.error.runtimeRemoved',
        'The build sandbox was removed before it finished.'
      )
    case 'boot_failed':
      return t('cloudEnvironment.error.bootFailed', 'The build sandbox failed to start.')
    case 'boot_timeout':
      return t('cloudEnvironment.error.bootTimeout', 'The build sandbox took too long to start.')
    case 'vm_lost':
      return t('cloudEnvironment.error.vmLost', 'Orca lost contact with the build sandbox.')
    case 'canceled':
      return t('cloudEnvironment.error.canceled', 'The build was canceled.')
    default:
      // The code itself is in Copy logs; the sentence stays plain.
      return t('cloudEnvironment.error.unknownPlain', 'Something went wrong during the build.')
  }
}

/**
 * What failed, and what that means for workspaces (never implies the failed build replaced the
 * active one): "Build #7 failed at Run install script." / "New workspaces still start from build #6."
 */
export function failedBuildSummary(
  buildNumber: number,
  failedStep: EnvironmentBuildStep | null,
  activeBuildNumber: number | null,
  t: Translate = translate
): { headline: string; consequence: string } {
  const number = String(buildNumber)
  return {
    headline: failedStep
      ? t('cloudEnvironment.failedAtStep', 'Build #{{number}} failed at {{step}}.', {
          number,
          step: stepLabel(failedStep, t)
        })
      : t('cloudEnvironment.failedPlain', 'Build #{{number}} failed.', { number }),
    consequence:
      activeBuildNumber === null
        ? t(
            'cloudEnvironment.failedNoActive',
            'New workspaces start without a prebuilt environment until a build succeeds.'
          )
        : t(
            'cloudEnvironment.failedStillActive',
            'New workspaces still start from build #{{active}}.',
            { active: String(activeBuildNumber) }
          )
  }
}

export function shortSha(commit: string | null): string {
  return commit ? commit.slice(0, 7) : ''
}
