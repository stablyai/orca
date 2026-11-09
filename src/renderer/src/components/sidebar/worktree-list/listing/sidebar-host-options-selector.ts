import { shallow } from 'zustand/shallow'
import type { useAppStore } from '@/store/index'
import { selectEphemeralVmHostLifecycles } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { persistedUIValuesEqual } from '../../../../../../shared/persisted-ui-equality'
import { selectWslHostsServing } from '../../use-wsl-hosts-enabled'
import { buildSidebarHostOptions, sidebarHostSemantics } from '../controls/sidebar-host-options'
import type { SectionRowsArgs } from './sidebar-list-model'

/** Keeps the previous host options until an input changes and the result means something different. */
export function createSidebarHostOptionsSelector() {
  let inputs: readonly unknown[] = []
  let result: ReturnType<typeof buildSidebarHostOptions> = []
  return (
    state: ReturnType<typeof useAppStore.getState>,
    repos: SectionRowsArgs['repos'],
    settings: SectionRowsArgs['settings'],
    hostLabelOverrides: Parameters<typeof buildSidebarHostOptions>[0]['hostLabelOverrides']
  ): ReturnType<typeof buildSidebarHostOptions> => {
    const options = {
      repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses: state.wslHostStatuses,
      wslHostsEnabled: selectWslHostsServing(state),
      wslHostServerFilesMissing: state.wslHostServerFiles === 'missing',
      ephemeralVmHosts: selectEphemeralVmHostLifecycles(state)
    }
    const nextInputs = Object.values(options)
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = buildSidebarHostOptions(options)
    if (!persistedUIValuesEqual(result.map(sidebarHostSemantics), next.map(sidebarHostSemantics))) {
      result = next
    }
    return result
  }
}
