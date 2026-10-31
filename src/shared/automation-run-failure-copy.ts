// One English table for automation run skip/failure reasons: main persists `error`, the renderer translates by code.
// Skip coalescing keys on exact `error` text, so wording changes here also split folded runs.
export const AUTOMATION_RUN_FAILURE_COPY = {
  noDispatchHost: 'No Orca window was available to launch the automation.',
  unevaluableSchedule: 'Orca could not evaluate this automation and skipped the occurrence.',
  noRunnableHost: 'This automation has no host to run on.',
  wslMoveInProgress:
    "This automation's project is moving to its WSL host, so Orca skipped this run. Runs resume when the move finishes.",
  wslMoveOwnedByHost:
    "This automation's project now runs on its WSL host, which runs this automation there. Orca no longer runs this local copy.",
  missedGraceWindow: 'This run was past its missed-run grace window when Orca next checked.',
  targetMissing:
    'The automation host is no longer registered, so this automation has nowhere to run.',
  targetReplaced:
    'The automation host was removed and re-registered, so this automation must be re-adopted before it can run.',
  workspaceHostAmbiguous:
    'The automation workspace spans more than one host, so Orca cannot tell which one to run it on.',
  legacyTwinHosts:
    'This automation was saved before Orca tracked which host it runs on, and its project is on more than one host. Open the automation and pick the host it should run on.',
  targetUnavailable: 'Automation run target is no longer available.',
  remoteSchedulingUnavailable:
    'Remote-server automation scheduling is not available from this Orca client yet. Run this automation on the remote server or update Orca when durable remote scheduling is available.',
  projectSetupMissing: 'Project is not set up on the selected automation host anymore.',
  projectSetupNotReady: 'Project setup on the selected automation host is {{setupState}}.',
  targetSetupMismatch: 'Automation run target no longer matches the selected project host setup.',
  repoUnavailable: 'Repository for the selected automation host is no longer available.',
  repoDetached: 'Repository is no longer attached to the selected automation host.',
  projectPathChanged: 'Project path for the selected automation host has changed.',
  automationChanged: 'The automation changed before this run could launch.',
  destinationChanged: 'The automation destination changed before this run could launch.',
  hooksReviewBlocked:
    'The agent is waiting for someone to review new or changed hooks ("Hooks need review"). Open this run and trust them, or remove them. Scheduled runs keep going and succeed once nothing needs review.',
  agentNeverStarted: 'Automation agent never started after the prompt was submitted.',
  agentNoCompletion: 'Automation agent did not report completion.',
  watchTimedOut: 'Orca stopped watching this run after 6h without a completion signal.',
  wslDistroStopped:
    'The WSL distro {{distro}} is stopped, so this scheduled run did not start it. Start the distro or use Run now; later runs go ahead while it runs.'
} as const

export type AutomationRunFailureCode = keyof typeof AUTOMATION_RUN_FAILURE_COPY

/** Optional wire/persisted fields next to the English `error`; absent on older hosts and records. */
export type AutomationRunFailureCodeFields = {
  errorCode?: string
  errorParams?: Record<string, string | number>
}

export type AutomationRunFailure = { error: string } & AutomationRunFailureCodeFields

export function automationRunFailure(
  errorCode: Exclude<AutomationRunFailureCode, 'projectSetupNotReady' | 'wslDistroStopped'>
): AutomationRunFailure
export function automationRunFailure(
  errorCode: 'projectSetupNotReady',
  params: { setupState: string }
): AutomationRunFailure
export function automationRunFailure(
  errorCode: 'wslDistroStopped',
  params: { distro: string }
): AutomationRunFailure
export function automationRunFailure(
  errorCode: AutomationRunFailureCode,
  params?: Record<string, string>
): AutomationRunFailure {
  const template: string = AUTOMATION_RUN_FAILURE_COPY[errorCode]
  return params
    ? {
        error: template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => params[key] ?? match),
        errorCode,
        errorParams: params
      }
    : { error: template, errorCode }
}

export function isAutomationRunFailureCode(value: unknown): value is AutomationRunFailureCode {
  return typeof value === 'string' && Object.hasOwn(AUTOMATION_RUN_FAILURE_COPY, value)
}

/** Only known, bounded reason parameters may cross the notification presentation boundary. */
export function readAutomationRunFailure(value: unknown):
  | {
      errorCode: AutomationRunFailureCode
      errorParams?: Record<string, string>
    }
  | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('errorCode' in value) ||
    !isAutomationRunFailureCode(value.errorCode)
  ) {
    return undefined
  }
  const errorCode = value.errorCode
  if (errorCode !== 'projectSetupNotReady' && errorCode !== 'wslDistroStopped') {
    return { errorCode }
  }
  const params = 'errorParams' in value ? value.errorParams : undefined
  if (!params || typeof params !== 'object') {
    return undefined
  }
  if (
    errorCode === 'projectSetupNotReady' &&
    'setupState' in params &&
    typeof params.setupState === 'string' &&
    ['not-set-up', 'setting-up', 'error', 'unsupported'].includes(params.setupState)
  ) {
    return { errorCode, errorParams: { setupState: params.setupState } }
  }
  if (
    errorCode === 'wslDistroStopped' &&
    'distro' in params &&
    typeof params.distro === 'string' &&
    params.distro.trim().length > 0 &&
    params.distro.length <= 120 &&
    [...params.distro].every((char) => char.charCodeAt(0) >= 32)
  ) {
    return { errorCode, errorParams: { distro: params.distro } }
  }
  return undefined
}
