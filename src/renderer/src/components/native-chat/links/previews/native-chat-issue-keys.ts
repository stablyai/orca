import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  jiraListProjectsForTarget,
  jiraStatusForTarget
} from '@/runtime/jira/runtime-jira-project-client'
import type { LinearTeam, LinearWorkspace } from '../../../../../../shared/linear/workspace-types'
import type { JiraProject, JiraSite } from '../../../../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { IssueKeyReferences } from '../../../../../../shared/work-items/issue-key-reference-links'
import { linearIssueUrlPrefix } from '../../../../../../shared/linear/linear-reference-links'

const TEAM_URL_ORG_PATTERN = /^https:\/\/linear\.app\/([A-Za-z0-9_-]+)\//

/** The organization a team's issue URLs use, from its workspace or else its own URL. */
function orgUrlKeyForTeam(team: LinearTeam, workspaces: readonly LinearWorkspace[]): string | null {
  const workspace =
    workspaces.find((candidate) => candidate.id === team.workspaceId) ??
    (!team.workspaceId && workspaces.length === 1 ? workspaces[0] : undefined)
  return workspace?.organizationUrlKey ?? TEAM_URL_ORG_PATTERN.exec(team.url ?? '')?.[1] ?? null
}

/** `[team key, issue URL prefix]` for each Linear team whose organization is known. */
export function linearIssueKeyPrefixes(
  teams: readonly LinearTeam[],
  workspaces: readonly LinearWorkspace[]
): [string, string][] {
  return teams.flatMap((team): [string, string][] => {
    const orgUrlKey = orgUrlKeyForTeam(team, workspaces)
    return orgUrlKey && team.key ? [[team.key, linearIssueUrlPrefix(orgUrlKey)]] : []
  })
}

/** `[project key, browse URL prefix]` for each Jira project on a connected site. */
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

/** Two trackers or workspaces can reuse a key. Such a key stays text: linking it to either
 *  one would guess which issue a reply meant. */
export function mergeIssueKeyPrefixes(...sources: [string, string][][]): IssueKeyReferences {
  const byKey = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [key, prefix] of sources.flat()) {
    const existing = byKey.get(key)
    if (existing !== undefined && existing !== prefix) {
      ambiguous.add(key)
    }
    byKey.set(key, existing ?? prefix)
  }
  for (const key of ambiguous) {
    byKey.delete(key)
  }
  return byKey
}

/** Key prefixes of every team in the connected Linear workspaces. */
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

type NativeChatJira = { sites: readonly JiraSite[]; projects: readonly JiraProject[] }

const NO_JIRA: NativeChatJira = { sites: [], projects: [] }

/** Jira sites and projects connected on the chat's host, not on the app's default host. */
function useNativeChatJira(target: RuntimeClientTarget): NativeChatJira {
  const [jira, setJira] = useState<{ target: RuntimeClientTarget; value: NativeChatJira } | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    void jiraStatusForTarget(target)
      .then(async (status) =>
        status.connected
          ? { sites: status.sites ?? [], projects: await jiraListProjectsForTarget(target, 'all') }
          : NO_JIRA
      )
      .then(
        (value) => !cancelled && setJira({ target, value }),
        () => !cancelled && setJira({ target, value: NO_JIRA })
      )
    return () => {
      cancelled = true
    }
  }, [target])
  return jira?.target === target ? jira.value : NO_JIRA
}

/** Issue keys of every connected Linear workspace and of the Jira sites on the chat's host, plus
 *  those Jira sites. */
export function useNativeChatIssueKeys(runtimeEnvironmentId: string | null): {
  issueKeys: IssueKeyReferences
  jiraSites: readonly JiraSite[]
} {
  const target = useMemo<RuntimeClientTarget>(
    () =>
      runtimeEnvironmentId
        ? { kind: 'environment', environmentId: runtimeEnvironmentId }
        : { kind: 'local' },
    [runtimeEnvironmentId]
  )
  const linear = useLinearKeyPrefixes()
  const jira = useNativeChatJira(target)
  return useMemo(
    () => ({
      issueKeys: mergeIssueKeyPrefixes(linear, jiraIssueKeyPrefixes(jira.projects, jira.sites)),
      jiraSites: jira.sites
    }),
    [linear, jira]
  )
}
