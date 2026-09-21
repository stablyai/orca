import type { Automation, AutomationRun } from './automations-types'

/**
 * Identity of the scheduled run a process was started for.
 *
 * Why: kept in sync with pty/wsl-orca-env.ts, which imports these keys into WSL, and with the
 * launch-identity scrub lists, which drop an inherited copy so an interactive launch cannot
 * claim an automation it is not part of. Every value is plain text, never a path.
 */
export const AUTOMATION_RUN_ENV_KEYS = [
  'ORCA_AUTOMATION_ID',
  'ORCA_AUTOMATION_NAME',
  'ORCA_AUTOMATION_RUN_ID',
  'ORCA_AUTOMATION_RUN_NUMBER',
  'ORCA_AUTOMATION_RUN_TRIGGER'
] as const

/**
 * The environment an automation stamps onto the processes it starts, so a wrapper script, a shell
 * profile, or the agent itself can branch on which automation and which run it is serving.
 *
 * `ORCA_AUTOMATION_RUN_NUMBER` is absent for runs recorded before the field existed; presence of
 * `ORCA_AUTOMATION_ID` is the test for "this is an automation, not an interactive launch".
 */
export function buildAutomationRunEnv(args: {
  automation: Pick<Automation, 'id' | 'name'>
  run: Pick<AutomationRun, 'id' | 'trigger' | 'runNumber'>
}): Record<string, string> {
  const { automation, run } = args
  return {
    ORCA_AUTOMATION_ID: automation.id,
    ORCA_AUTOMATION_NAME: automation.name,
    ORCA_AUTOMATION_RUN_ID: run.id,
    ...(run.runNumber === undefined ? {} : { ORCA_AUTOMATION_RUN_NUMBER: String(run.runNumber) }),
    ORCA_AUTOMATION_RUN_TRIGGER: run.trigger
  }
}
