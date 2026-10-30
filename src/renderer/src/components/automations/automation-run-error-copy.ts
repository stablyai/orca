import { translate } from '@/i18n/i18n'
import {
  AUTOMATION_RUN_FAILURE_COPY as EN,
  type AutomationRunFailureCode
} from '../../../../shared/automation-run-failure-copy'
import type { AutomationRun } from '../../../../shared/automations-types'

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

/** Old records and older hosts omit the code; newer hosts may send unknown codes. Both show `error`. */
export function automationRunErrorText(
  run: Pick<AutomationRun, 'error' | 'errorCode' | 'errorParams'>
): string | null {
  if (run.error === null || !isAutomationRunFailureCode(run.errorCode)) {
    return run.error
  }
  return COPY[run.errorCode](run.errorParams) ?? run.error
}
