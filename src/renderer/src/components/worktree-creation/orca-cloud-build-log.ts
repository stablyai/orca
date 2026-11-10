import type { Translate } from '@/i18n/use-translate'

// The hosted provider writes `[orca-cloud] <phase>` progress, `Orca Cloud: <deny reason>` and a few
// fixed transport messages. Everything else is provider internals that the plain view hides.
const PHASE_LINE = /^\[orca-cloud\] ([a-z-]+)$/
const DENY_LINE = /^Orca Cloud: ([a-z_ ]+)$/
const REFUSED_LINE = /^Orca Cloud refused the request \(([a-z_]+)\)\.$/

function phaseLabel(phase: string, t: Translate): string | null {
  switch (phase) {
    case 'checking-entitlement':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.checkingPlan',
        'Checking your plan…'
      )
    case 'provisioning':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.provisioning',
        'Starting the sandbox…'
      )
    case 'booting':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.booting',
        'Booting the sandbox…'
      )
    case 'connecting':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.connecting',
        'Connecting to the sandbox…'
      )
    case 'resuming':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.resuming',
        'Waking the sandbox…'
      )
    case 'suspending':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.suspending',
        'Putting the sandbox to sleep…'
      )
    case 'renewing':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.renewing2',
        'Keeping the sandbox running…'
      )
    case 'rolling-over':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.rollingOver2',
        'Restarting the sandbox…'
      )
    case 'destroying':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.destroying',
        'Deleting the sandbox…'
      )
    default:
      return null
  }
}

function denyLabel(reason: string, t: Translate): string | null {
  switch (reason) {
    case 'no plan':
    case 'no_subscription':
    case 'subscription_inactive':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyNoPlan',
        'Your account has no active Team plan.'
      )
    case 'included_hours_exhausted':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyHours2',
        'Your team is out of sandbox hours this month.'
      )
    case 'overage_cap_reached':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denySpendCap',
        'This month’s spend cap is reached.'
      )
    case 'payment_past_due':
    case 'payment_grace_expired':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyPayment2',
        'Payment failed.'
      )
    case 'concurrency_limit':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyConcurrency2',
        'You’re at your team’s limit of running sandboxes.'
      )
    case 'member_concurrency_limit':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyMemberConcurrency2',
        'You’re at your limit of running sandboxes.'
      )
    case 'github_not_connected':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyGithub',
        'GitHub isn’t connected to your Orca account.'
      )
    case 'machine_size_not_in_plan':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.denyMachineSize2',
        'This sandbox size isn’t part of your plan.'
      )
    default:
      return null
  }
}

function refusedLabel(code: string, t: Translate): string {
  switch (code) {
    case 'billing_unavailable':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.refusedBilling',
        'Orca Cloud couldn’t check your plan.'
      )
    case 'provider_unavailable':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.refusedProvider2',
        'Orca Cloud is unavailable right now.'
      )
    case 'not_configured':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.refusedNotConfigured',
        'Orca Cloud isn’t set up on the server.'
      )
    case 'unauthorized':
    case 'forbidden':
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.refusedSignIn',
        'Orca Cloud needs you to sign in again.'
      )
    default:
      return t(
        'auto.components.worktree.creation.orcaCloudBuildLog.refused',
        'Orca Cloud refused the request.'
      )
  }
}

/** A provider line in plain words, or null when it is an internal detail the plain view hides. */
export function humanizeOrcaCloudLogLine(line: string, t: Translate): string | null {
  const text = line.trim()
  const phase = PHASE_LINE.exec(text)?.[1]
  if (phase) {
    return phaseLabel(phase, t)
  }
  const reason = DENY_LINE.exec(text)?.[1]
  if (reason) {
    return denyLabel(reason, t)
  }
  const refused = REFUSED_LINE.exec(text)?.[1]
  if (refused) {
    return refusedLabel(refused, t)
  }
  if (/^Orca Cloud request failed \(HTTP \d+\)\.$/.test(text)) {
    return t(
      'auto.components.worktree.creation.orcaCloudBuildLog.httpError',
      'Orca Cloud answered with an error.'
    )
  }
  if (text === 'Could not reach Orca Cloud.') {
    return t(
      'auto.components.worktree.creation.orcaCloudBuildLog.unreachable',
      'Couldn’t reach Orca Cloud.'
    )
  }
  if (text === 'Orca Cloud did not answer in time.') {
    return t(
      'auto.components.worktree.creation.orcaCloudBuildLog.timeout',
      'Orca Cloud didn’t answer in time.'
    )
  }
  return null
}

// "Starting the sandbox…" would only repeat the step's own label.
const DETAIL_PHASES = new Set(['checking-entitlement', 'booting', 'connecting'])

/** The latest progress phase in the log, in plain words, for the running step's detail line. */
export function latestOrcaCloudPhaseLabel(log: string, t: Translate): string | null {
  const lines = log.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const phase = PHASE_LINE.exec(lines[index].trim())?.[1]
    if (phase && phaseLabel(phase, t)) {
      return DETAIL_PHASES.has(phase) ? phaseLabel(phase, t) : null
    }
  }
  return null
}
