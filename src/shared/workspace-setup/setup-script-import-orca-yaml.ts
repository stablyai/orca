import { stringify } from 'yaml'
import type { OrcaRunAction } from '../orca-yaml-hook-types'
import { defaultRunActionName, LEGACY_RUN_ACTION_ID } from '../orca-yaml-run-actions'
import type { SetupScriptImportCandidate } from './setup-script-imports'

/**
 * orca.yaml text for an imported candidate: setup, archive and the `scripts.run` block.
 * Keys come out in a fixed order and defaults are omitted, so the same import writes the same file.
 */
export function formatSetupScriptImportAsOrcaYaml(candidate: SetupScriptImportCandidate): string {
  const scripts: Record<string, unknown> = { setup: candidate.setup }
  if (candidate.archive) {
    scripts.archive = candidate.archive
  }
  if (candidate.run && candidate.run.length > 0) {
    scripts.run = formatRunActions(candidate.run)
    if (candidate.runMode) {
      scripts.runMode = candidate.runMode
    }
    if (candidate.autoRunAfterSetup) {
      scripts.autoRunAfterSetup = candidate.autoRunAfterSetup
    }
  }
  // lineWidth 0 keeps long commands on one line instead of folding them.
  return stringify({ scripts }, { lineWidth: 0 })
}

function formatRunActions(actions: readonly OrcaRunAction[]): unknown {
  const [only] = actions
  if (actions.length === 1 && isBareLegacyAction(only)) {
    return only.command
  }
  const record: Record<string, unknown> = {}
  for (const action of actions) {
    record[action.id] = formatRunAction(action)
  }
  return record
}

function isBareLegacyAction(action: OrcaRunAction): boolean {
  return (
    action.id === LEGACY_RUN_ACTION_ID &&
    action.name === 'Run' &&
    !action.cwd &&
    !action.env &&
    !action.default &&
    !action.runMode &&
    !action.availableIn
  )
}

function formatRunAction(action: OrcaRunAction): Record<string, unknown> {
  return {
    ...(action.name !== defaultRunActionName(action.id) ? { name: action.name } : {}),
    command: action.command,
    ...(action.cwd ? { cwd: action.cwd } : {}),
    ...(action.env ? { env: action.env } : {}),
    ...(action.default ? { default: true } : {}),
    ...(action.runMode ? { runMode: action.runMode } : {}),
    ...(action.availableIn ? { availableIn: action.availableIn } : {})
  }
}
