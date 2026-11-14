import { selectWslHostsServing } from '../../use-wsl-hosts-enabled'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { selectEphemeralVmHostLifecycles } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { readUiLanguageMemoInput } from '@/i18n/ui-language-memo-input'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import {
  buildSidebarHostOptions,
  buildSidebarHostScopeOptions,
  type SidebarHostOption,
  type SidebarHostScopeOption
} from './sidebar-host-options'

/** Share live host derivation between the scope strip and workspace options. */
export function useSidebarHostScopeOptions(): {
  hostOptions: SidebarHostOption[]
  hostScopeOptions: SidebarHostScopeOption[]
} {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const repos = useAppStore((s) => s.repos)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const wslHostStatuses = useAppStore((s) => s.wslHostStatuses)
  const wslHostServerFilesMissing = useAppStore((s) => s.wslHostServerFiles === 'missing')
  const ephemeralVmHosts = useAppStore(selectEphemeralVmHostLifecycles)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostOptions = useMemo(() => {
    readUiLanguageMemoInput(language)
    return buildSidebarHostOptions({
      repos,
      sshTargetLabels,
      sshConnectionStates,
      settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses,
      wslHostsEnabled: selectWslHostsServing({ settings, runtimeEnvironments }),
      wslHostServerFilesMissing,
      ephemeralVmHosts
    })
  }, [
    repos,
    sshTargetLabels,
    sshConnectionStates,
    settings,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    hostLabelOverrides,
    wslHostStatuses,
    wslHostServerFilesMissing,
    ephemeralVmHosts,
    language
  ])
  const hostScopeOptions = useMemo(() => buildSidebarHostScopeOptions(hostOptions), [hostOptions])

  return { hostOptions, hostScopeOptions }
}
