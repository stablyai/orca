import { translate } from '@/i18n/i18n'
import {
  AUTOMATION_RUN_FAILURE_COPY as EN,
  type AutomationRunFailureCode
} from '../../../../../shared/automations/history/automation-run-failure-copy'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'

// One whole sentence per non-ready setup state; unknown states keep the stored English.
const SETUP_STATE_COPY: Record<string, () => string> = {
  'not-set-up': () =>
    translate(
      'automations.runFailures.projectSetupState.notSetUp',
      'The project is not set up on the selected automation host.'
    ),
  'setting-up': () =>
    translate(
      'automations.runFailures.projectSetupState.settingUp',
      'The project is still being set up on the selected automation host.'
    ),
  error: () =>
    translate(
      'automations.runFailures.projectSetupState.error',
      'Project setup failed on the selected automation host.'
    ),
  unsupported: () =>
    translate(
      'automations.runFailures.projectSetupState.unsupported',
      'The selected automation host does not support this project.'
    )
}

// null = unusable params; caller shows the stored English `error`.
const COPY: Record<
  AutomationRunFailureCode,
  (params: AutomationRun['errorParams']) => string | null
> = {
  noDispatchHost: () => translate('automations.runFailures.noDispatchHost', EN.noDispatchHost),
  unevaluableSchedule: () =>
    translate('automations.runFailures.unevaluableSchedule', EN.unevaluableSchedule),
  noRunnableHost: () => translate('automations.runFailures.noRunnableHost', EN.noRunnableHost),
  wslMoveInProgress: () =>
    translate('automations.runFailures.wslMoveInProgress', EN.wslMoveInProgress),
  wslMoveOwnedByHost: () =>
    translate('automations.runFailures.wslMoveOwnedByHost', EN.wslMoveOwnedByHost),
  managedHostServer: (params) => {
    const host = params?.host
    return typeof host === 'string'
      ? translate('automations.runFailures.managedHostServer', EN.managedHostServer, { host })
      : null
  },
  missedGraceWindow: () =>
    translate('automations.runFailures.missedGraceWindow', EN.missedGraceWindow),
  targetMissing: () => translate('automations.runFailures.targetMissing', EN.targetMissing),
  targetReplaced: () => translate('automations.runFailures.targetReplaced', EN.targetReplaced),
  workspaceHostAmbiguous: () =>
    translate('automations.runFailures.workspaceHostAmbiguous', EN.workspaceHostAmbiguous),
  legacyTwinHosts: () => translate('automations.runFailures.legacyTwinHosts', EN.legacyTwinHosts),
  targetUnavailable: () =>
    translate('automations.runFailures.targetUnavailable', EN.targetUnavailable),
  remoteSchedulingUnavailable: () =>
    translate(
      'automations.runFailures.remoteSchedulingUnavailable',
      EN.remoteSchedulingUnavailable
    ),
  projectSetupMissing: () =>
    translate('automations.runFailures.projectSetupMissing', EN.projectSetupMissing),
  projectSetupNotReady: (params) => {
    const state = params?.setupState
    return typeof state === 'string' && Object.hasOwn(SETUP_STATE_COPY, state)
      ? SETUP_STATE_COPY[state]()
      : null
  },
  targetSetupMismatch: () =>
    translate('automations.runFailures.targetSetupMismatch', EN.targetSetupMismatch),
  repoUnavailable: () => translate('automations.runFailures.repoUnavailable', EN.repoUnavailable),
  repoDetached: () => translate('automations.runFailures.repoDetached', EN.repoDetached),
  projectPathChanged: () =>
    translate('automations.runFailures.projectPathChanged', EN.projectPathChanged),
  automationChanged: () =>
    translate('automations.runFailures.automationChanged', EN.automationChanged),
  destinationChanged: () =>
    translate('automations.runFailures.destinationChanged', EN.destinationChanged),
  hooksReviewBlocked: () =>
    translate('automations.runFailures.hooksReviewBlocked', EN.hooksReviewBlocked),
  agentNeverStarted: () =>
    translate('automations.runFailures.agentNeverStarted', EN.agentNeverStarted),
  agentNoCompletion: () =>
    translate('automations.runFailures.agentNoCompletion', EN.agentNoCompletion),
  agentInterrupted: () =>
    translate('automations.runFailures.agentInterrupted', EN.agentInterrupted),
  watchTimedOut: () => translate('automations.runFailures.watchTimedOut', EN.watchTimedOut),
  wslDistroStopped: (params) => {
    const distro = params?.distro
    return typeof distro === 'string'
      ? translate('automations.runFailures.wslDistroStopped', EN.wslDistroStopped, { distro })
      : null
  }
}

function isAutomationRunFailureCode(code: unknown): code is AutomationRunFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

// Main records a blocked agent as "Automation agent is blocked: <reason>." with no code.
const BLOCKED_AGENT_ERROR = /^Automation agent is blocked: ([a-z0-9-]+)\.?$/

// Why: the reason is an internal detector id; people need to know what the agent is waiting for.
function blockedAgentText(reason: string, agentLabel: string | undefined): string {
  const kind = reason.replace(/^(agent|codex)-/, '')
  switch (kind) {
    case 'trust-workspace':
      return agentLabel
        ? translate(
            'automations.runFailures.blocked.trustWorkspaceNamed',
            '{{agent}} is waiting for you to trust this folder.',
            { agent: agentLabel }
          )
        : translate(
            'automations.runFailures.blocked.trustWorkspace',
            'The agent is waiting for you to trust this folder.'
          )
    case 'update-prompt':
      return translate(
        'automations.runFailures.blocked.update',
        'The agent is waiting for you to answer an update prompt.'
      )
    case 'cwd-prompt':
      return translate(
        'automations.runFailures.blocked.folder',
        'The agent is asking which folder to work in.'
      )
    case 'model-migration-prompt':
      return translate(
        'automations.runFailures.blocked.model',
        'The agent is asking you to choose a model.'
      )
    case 'hooks-review-prompt':
      return translate('automations.runFailures.hooksReviewBlocked', EN.hooksReviewBlocked)
    case 'approval-prompt':
      return translate(
        'automations.runFailures.blocked.approval',
        'The agent is waiting for you to approve an action.'
      )
    case 'sign-in-prompt':
      return translate(
        'automations.runFailures.blocked.signIn',
        'The agent is waiting for you to sign in.'
      )
    default:
      return translate(
        'automations.runFailures.blocked.prompt',
        'The agent stopped at a prompt that needs your answer.'
      )
  }
}

/** Old records and older hosts omit the code; newer hosts may send unknown codes. Both show `error`. */
export function automationRunErrorText(
  run: Pick<AutomationRun, 'error' | 'errorCode' | 'errorParams'>,
  /** Names the agent in prompts it is waiting on, e.g. "Claude". */
  agentLabel?: string
): string | null {
  if (run.error === null) {
    return null
  }
  if (!isAutomationRunFailureCode(run.errorCode)) {
    const blocked = BLOCKED_AGENT_ERROR.exec(run.error)
    return blocked ? blockedAgentText(blocked[1], agentLabel) : run.error
  }
  return COPY[run.errorCode](run.errorParams) ?? run.error
}
