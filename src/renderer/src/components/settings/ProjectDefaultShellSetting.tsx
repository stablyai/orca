import type { GlobalSettings, Project, ProjectUpdateArgs } from '../../../../shared/types'
import type { ProjectDefaultShell } from '../../../../shared/project-default-shell'
import {
  normalizeProjectRuntimePreference,
  resolveProjectExecutionRuntime
} from '../../../../shared/project-execution-runtime'
import { isWslRuntimeResolution } from '../../../../shared/wsl-repo-identity'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type ShellOption = Exclude<ProjectDefaultShell, 'wsl'>

const SHELL_OPTIONS: readonly ShellOption[] = ['inherit', 'powershell', 'cmd', 'git-bash']

type ProjectDefaultShellSettingProps = {
  project: Project | null
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  isLocalWindowsProject: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}

export function ProjectDefaultShellSetting({
  project,
  settings,
  isLocalWindowsProject,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  updateProject
}: ProjectDefaultShellSettingProps): React.JSX.Element | null {
  if (!project || !isLocalWindowsProject) {
    return null
  }

  const preference = normalizeProjectRuntimePreference(project.localWindowsRuntimePreference)
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: project.id,
    projectRuntimePreference: preference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault,
    wslAvailable: wslCapabilitiesLoading ? undefined : wslAvailable,
    availableWslDistros: wslCapabilitiesLoading ? null : wslDistros
  })
  // Why: mirrors resolveDefaultShell's policy — a WSL-runtime project (and a
  // repair-required one, which also stays on WSL) always uses the WSL shell,
  // so this axis has nothing to control until the project is back on Windows.
  const isWslLocked = isWslRuntimeResolution(resolution) || resolution.status === 'repair-required'
  const selectedShell: ShellOption =
    project.defaultShell && project.defaultShell !== 'wsl' ? project.defaultShell : 'inherit'

  const handleChange = (value: string): void => {
    const shell = value as ShellOption
    void updateProject(project.id, { defaultShell: shell === 'inherit' ? undefined : shell })
  }

  return (
    <SettingsRow
      label={translate(
        'auto.components.settings.ProjectDefaultShellSetting.defaultShell',
        'Default shell'
      )}
      description={
        isWslLocked
          ? translate(
              'auto.components.settings.ProjectDefaultShellSetting.wslLocked',
              'This project runs in WSL, which always uses the WSL shell.'
            )
          : translate(
              'auto.components.settings.ProjectDefaultShellSetting.description',
              'Shell used when opening new terminals for this project.'
            )
      }
      control={
        <Select value={selectedShell} onValueChange={handleChange} disabled={isWslLocked}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHELL_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {getShellOptionLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}

function getShellOptionLabel(option: ShellOption): string {
  switch (option) {
    case 'inherit':
      return translate(
        'auto.components.settings.ProjectDefaultShellSetting.inherit',
        'Use global default'
      )
    case 'powershell':
      return translate(
        'auto.components.settings.ProjectDefaultShellSetting.powershell',
        'PowerShell'
      )
    case 'cmd':
      return translate('auto.components.settings.ProjectDefaultShellSetting.cmd', 'CMD')
    case 'git-bash':
      return translate('auto.components.settings.ProjectDefaultShellSetting.gitBash', 'Git Bash')
  }
}
