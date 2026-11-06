import { shallow } from 'zustand/shallow'
import type { useAppStore } from '@/store/index'
import { persistedUIValuesEqual } from '../../../../../../shared/persisted-ui-equality'
import { selectWslHostsServing } from '../../use-wsl-hosts-enabled'
import { buildSidebarHostOptions, sidebarHostSemantics } from '../controls/sidebar-host-options'
import type { SectionRowsArgs } from './sidebar-list-model'

/** Keeps host options referentially stable until an input or a host's semantics change. */
export function createSidebarHostOptionsSelector() {
  let inputs: readonly unknown[] = []
  let result: ReturnType<typeof buildSidebarHostOptions> = []
  return (
    state: ReturnType<typeof useAppStore.getState>,
    repos: SectionRowsArgs['repos'],
    settings: SectionRowsArgs['settings'],
    hostLabelOverrides: Parameters<typeof buildSidebarHostOptions>[0]['hostLabelOverrides']
  ): ReturnType<typeof buildSidebarHostOptions> => {
    const nextInputs = [
      repos,
      state.sshTargetLabels,
      state.sshConnectionStates,
      settings,
      state.runtimeStatusByEnvironmentId,
      state.runtimeEnvironments,
      hostLabelOverrides,
      state.wslHostStatuses,
      selectWslHostsServing(state),
      state.wslHostServerFiles === 'missing'
    ]
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = buildSidebarHostOptions({
      repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses: state.wslHostStatuses,
      wslHostsEnabled: selectWslHostsServing(state),
      wslHostServerFilesMissing: state.wslHostServerFiles === 'missing'
    })
    if (!persistedUIValuesEqual(result.map(sidebarHostSemantics), next.map(sidebarHostSemantics))) {
      result = next
    }
    return result
  }
}
