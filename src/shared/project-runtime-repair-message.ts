// The words for a project runtime that needs repair, under the project settings page's keys. The
// window passes its translator; the host writes English, like its other refusals.
import type {
  ProjectExecutionRuntimeRepair,
  ProjectExecutionRuntimeRepairReason
} from './project-execution-runtime'

/** A launch refused, before any spawn, because its project's runtime needs repair. */
export const PROJECT_RUNTIME_REPAIR_REQUIRED_CODE = 'project_runtime_repair_required'

export type RepairTranslate = (key: string, fallback: string, values: { value0: string }) => string

const REPAIR_WORDS: Record<ProjectExecutionRuntimeRepairReason, [key: string, english: string]> = {
  'wsl-unavailable': [
    'auto.components.settings.ProjectWindowsRuntimeSetting.wslUnavailable',
    'WSL is not available. Switch this project to Windows or repair WSL.'
  ],
  'wsl-distro-missing': [
    'auto.components.settings.ProjectWindowsRuntimeSetting.distroMissing',
    '{{value0}} is not installed in WSL. Choose an installed distro or switch this project to Windows.'
  ],
  'wsl-distro-required': [
    'auto.components.settings.ProjectWindowsRuntimeSetting.distroRequired',
    'Choose a WSL distro or switch this project to Windows.'
  ]
}

export function projectRuntimeRepairSentence(
  repair: ProjectExecutionRuntimeRepair,
  t: RepairTranslate
): string {
  const [key, english] = REPAIR_WORDS[repair.reason]
  return t(key, english, { value0: repair.preferredRuntime.distro ?? 'WSL' })
}

const english: RepairTranslate = (_key, fallback, { value0 }) =>
  fallback.replace('{{value0}}', value0)

/** What an agent launch refused for this repair says: what happened, then the settings sentence. */
export function agentLaunchRepairRefusal(repair: ProjectExecutionRuntimeRepair): string {
  const byDefault =
    repair.source === 'global-default'
      ? ' This project follows the default in Settings > Project Runtime.'
      : ''
  return `No agent was started. ${projectRuntimeRepairSentence(repair, english)}${byDefault}`
}
