import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { useTranslate } from '@/i18n/use-translate'
import {
  agentCliUpdateRows,
  type AgentCliUpdateGroup
} from '../status-bar/updates/AgentCliUpdateList'

const NAMES_BY_CATALOG = new WeakMap<
  AppState['runtimeEnvironments'],
  Readonly<Record<string, string>>
>()
let lastNames: Readonly<Record<string, string>> = Object.freeze({})

/** Host names by id, built once per catalog array so unrelated store writes cost one lookup. */
function hostNames(state: AppState): Readonly<Record<string, string>> {
  const catalog = state.runtimeEnvironments
  let names = NAMES_BY_CATALOG.get(catalog)
  if (!names) {
    const built = Object.fromEntries(
      catalog.map((environment) => [environment.id, environment.name])
    )
    // Equal names keep one object, so a catalog change that keeps every name (a last-used time) re-renders no reader.
    names = shallow(built, lastNames) ? lastNames : built
    lastNames = names
    NAMES_BY_CATALOG.set(catalog, names)
  }
  return names
}

/** Every host's offered or running CLI updates, this computer first, labelled once another host is added. */
export function useAgentCliUpdateGroups(): AgentCliUpdateGroup[] {
  const t = useTranslate()
  const hosts = useAppStore((s) => s.agentCliUpdates)
  const names = useAppStore(hostNames)
  const hasOtherHosts = useAppStore(
    (s) => !isPairedWebClientWindow() && s.runtimeEnvironments.length > 0
  )
  return useMemo((): AgentCliUpdateGroup[] => {
    const listed = [...hosts]
      .map(([hostKey, host]) => ({ hostKey, rows: agentCliUpdateRows(hostKey, host) }))
      .filter((group) => group.rows.length > 0)
      .sort((a, b) => (a.hostKey === '' ? -1 : b.hostKey === '' ? 1 : 0))
    // With any other host added (server, WSL host or VM), a local-only list still names this computer.
    const showHostHeadings = hasOtherHosts || listed.some((group) => group.hostKey !== '')
    return listed.map((group) => ({
      ...group,
      label: !showHostHeadings
        ? null
        : group.hostKey === ''
          ? t('agentCliUpdate.thisComputer', 'This computer')
          : Object.hasOwn(names, group.hostKey)
            ? names[group.hostKey]
            : group.hostKey
    }))
  }, [hosts, names, hasOtherHosts, t])
}
