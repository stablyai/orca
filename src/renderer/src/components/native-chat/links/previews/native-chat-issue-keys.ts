import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useJiraProjectInventory } from '@/components/use-jira-project-inventory'
import type { LinearTeam, LinearWorkspace } from '../../../../../../shared/linear/workspace-types'
import type { JiraProject, JiraSite } from '../../../../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { IssueKeyReferences } from '../../../../../../shared/work-items/issue-key-reference-links'
import { linearIssueUrlPrefix } from '../../../../../../shared/linear/linear-reference-links'

const TEAM_URL_ORG_PATTERN = /^https:\/\/linear\.app\/([A-Za-z0-9_-]+)\//

function orgUrlKeyForTeam(team: LinearTeam, workspaces: readonly LinearWorkspace[]): string | null {
  const workspace =
    workspaces.find((candidate) => candidate.id === team.workspaceId) ??
    (workspaces.length === 1 ? workspaces[0] : undefined)
  return workspace?.organizationUrlKey ?? TEAM_URL_ORG_PATTERN.exec(team.url ?? '')?.[1] ?? null
}

export function linearIssueKeyPrefixes(
  teams: readonly LinearTeam[],
  workspaces: readonly LinearWorkspace[]
): [string, string][] {
  return teams.flatMap((team): [string, string][] => {
    const orgUrlKey = orgUrlKeyForTeam(team, workspaces)
    return orgUrlKey && team.key ? [[team.key, linearIssueUrlPrefix(orgUrlKey)]] : []
  })
}

export function jiraIssueKeyPrefixes(
  projects: readonly JiraProject[],
  sites: readonly JiraSite[]
): [string, string][] {
  return projects.flatMap((project): [string, string][] => {
    const site =
      sites.find((candidate) => candidate.id === project.siteId) ??
      (sites.length === 1 ? sites[0] : undefined)
    return site && project.key ? [[project.key, `${site.siteUrl.replace(/\/+$/, '')}/browse/`]] : []
  })
}

/** Two trackers or workspaces can reuse a key; the first keeps it rather than guess which one a reply meant. */
export function mergeIssueKeyPrefixes(...sources: [string, string][][]): IssueKeyReferences {
  const byKey = new Map<string, string>()
  for (const [key, prefix] of sources.flat()) {
    if (!byKey.has(key)) {
      byKey.set(key, prefix)
    }
  }
  return byKey
}

function useLinearKeyPrefixes(): [string, string][] {
  const connected = useAppStore((state) => state.linearStatus.connected)
  const workspaces = useAppStore((state) => state.linearStatus.workspaces)
  const [teams, setTeams] = useState<readonly LinearTeam[] | null>(() =>
    connected ? useAppStore.getState().getCachedLinearTeams('all') : null
  )
  useEffect(() => {
    if (!connected) {
      setTeams(null)
      return
    }
    let cancelled = false
    void useAppStore
      .getState()
      .listLinearTeams('all')
      .then(
        (next) => !cancelled && setTeams(next),
        () => undefined
      )
    return () => {
      cancelled = true
    }
  }, [connected, workspaces])
  return useMemo(
    () => (connected && teams ? linearIssueKeyPrefixes(teams, workspaces ?? []) : []),
    [connected, teams, workspaces]
  )
}

function useJiraKeyPrefixes(target: RuntimeClientTarget): [string, string][] {
  const connected = useAppStore((state) => state.jiraStatus.connected)
  const sites = useAppStore((state) => state.jiraStatus.sites)
  const { projects } = useJiraProjectInventory(target, connected)
  return useMemo(
    () => (connected ? jiraIssueKeyPrefixes(projects, sites ?? []) : []),
    [connected, projects, sites]
  )
}

/** Issue keys of every connected Linear workspace and Jira site, read on the chat's host. */
export function useNativeChatIssueKeys(runtimeEnvironmentId: string | null): IssueKeyReferences {
  const target = useMemo<RuntimeClientTarget>(
    () =>
      runtimeEnvironmentId
        ? { kind: 'environment', environmentId: runtimeEnvironmentId }
        : { kind: 'local' },
    [runtimeEnvironmentId]
  )
  const linear = useLinearKeyPrefixes()
  const jira = useJiraKeyPrefixes(target)
  return useMemo(() => mergeIssueKeyPrefixes(linear, jira), [linear, jira])
}
