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
const NO_HOST_NAMES: Readonly<Record<string, string>> = Object.freeze({})
let lastNames = NO_HOST_NAMES

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
    NAMES_BY_CATALOG.set(catalog, names)
  }
  lastNames = names
  return names
}

function noHostNames(): Readonly<Record<string, string>> {
  // Lets go of the last catalog's names while none are needed.
  lastNames = NO_HOST_NAMES
  return NO_HOST_NAMES
}

/** Every host's offered or running CLI updates, this computer first, labelled once another host is added. */
export function useAgentCliUpdateGroups(): AgentCliUpdateGroup[] {
  const t = useTranslate()
  const hosts = useAppStore((s) => s.agentCliUpdates)
  const listed = useMemo(
    () =>
      [...hosts]
        .map(([hostKey, host]) => ({ hostKey, rows: agentCliUpdateRows(hostKey, host) }))
        .filter((group) => group.rows.length > 0)
        .sort((a, b) => (a.hostKey === '' ? -1 : b.hostKey === '' ? 1 : 0)),
    [hosts]
  )
  const hasRemote = listed.some((group) => group.hostKey !== '')
  // Only another host's rows need a label, so the always-mounted status segment never reads the catalog for none.
  const names = useAppStore(hasRemote ? hostNames : noHostNames)
  const hasOtherHosts = useAppStore(
    (s) => !isPairedWebClientWindow() && s.runtimeEnvironments.length > 0
  )
  return useMemo((): AgentCliUpdateGroup[] => {
    // With any other host added (server, WSL host or VM), a local-only list still names this computer.
    const showHostHeadings = hasOtherHosts || hasRemote
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
  }, [listed, hasRemote, names, hasOtherHosts, t])
}
