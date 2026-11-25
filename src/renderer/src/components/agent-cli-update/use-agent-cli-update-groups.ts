import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { useTranslate } from '@/i18n/use-translate'
import {
  agentCliUpdateRows,
  type AgentCliUpdateGroup
} from '../status-bar/updates/AgentCliUpdateList'

const NO_HOST_NAMES: Readonly<Record<string, string>> = Object.freeze({})

/** Names of paired servers with listed updates; the shared empty value keeps always-mounted readers still. */
function remoteHostNames(state: AppState): Readonly<Record<string, string>> {
  const keys = [...state.agentCliUpdates.keys()].filter((key) => key !== '')
  if (keys.length === 0) {
    return NO_HOST_NAMES
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      state.runtimeEnvironments.find((environment) => environment.id === key)?.name ?? key
    ])
  )
}

/** Every host's offered or running CLI updates, this computer first, labelled once another host is added. */
export function useAgentCliUpdateGroups(): AgentCliUpdateGroup[] {
  const t = useTranslate()
  const hosts = useAppStore((s) => s.agentCliUpdates)
  const hostNames = useAppStore(useShallow(remoteHostNames))
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
          : (hostNames[group.hostKey] ?? group.hostKey)
    }))
  }, [hosts, hostNames, hasOtherHosts, t])
}
