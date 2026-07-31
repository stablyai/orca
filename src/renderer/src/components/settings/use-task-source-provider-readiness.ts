import { useMemo } from 'react'
import type { TaskProvider } from '../../../../shared/types'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { LINEAR_AGENT_SKILL_NAMES } from '@/lib/agent-feature-install-commands'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import type { TaskProviderReadiness } from './task-source-setup-state'

export function useTaskSourceProviderReadiness(
  visibleProviders: readonly TaskProvider[]
): Record<TaskProvider, TaskProviderReadiness> {
  const settings = useAppStore((s) => s.settings)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const linearConnected = useLinearProviderConnected()
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const activeSkillRuntime = useActiveProjectSkillRuntime()

  const {
    installed: linearSkillInstalled,
    loading: linearSkillLoading,
    settled: linearSkillSettled
  } = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const preflightCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const reviewChecking = preflightStatusLoading || !preflightStatusChecked || !preflightCurrent
  // A failed preflight leaves the previous status object in place, so mirror
  // Integrations and refuse to read connection facts out of a stale snapshot.
  const reviewReadyForConnection = !reviewChecking && preflightStatusError === null
  const reviewUnavailable = !reviewChecking && preflightStatusError !== null
  const githubConnected =
    reviewReadyForConnection &&
    preflightStatus?.gh?.installed === true &&
    preflightStatus.gh.authenticated === true
  const gitlabConnected =
    reviewReadyForConnection &&
    preflightStatus?.glab?.installed === true &&
    preflightStatus.glab.authenticated === true
  const jiraChecking = jiraStatusContextKey !== providerRuntimeContextKey || !jiraStatusChecked
  const jiraConnected = !jiraChecking && jiraStatus.connected === true
  const linearChecking =
    linearStatusContextKey !== providerRuntimeContextKey || !linearStatusChecked
  // Normalization returns a new array, so memoize by provider contents.
  const visibleProvidersKey = visibleProviders.join(',')

  return useMemo(() => {
    const visible = new Set(visibleProvidersKey.split(',') as TaskProvider[])
    return {
      github: {
        connected: githubConnected,
        checking: reviewChecking,
        unavailable: reviewUnavailable,
        visible: visible.has('github')
      },
      gitlab: {
        connected: gitlabConnected,
        checking: reviewChecking,
        unavailable: reviewUnavailable,
        visible: visible.has('gitlab')
      },
      linear: {
        connected: linearConnected,
        checking: linearChecking,
        skillInstalled: linearSkillInstalled,
        skillChecking: linearSkillLoading && !linearSkillSettled,
        visible: visible.has('linear')
      },
      jira: {
        connected: jiraConnected,
        checking: jiraChecking,
        visible: visible.has('jira')
      }
    }
  }, [
    githubConnected,
    gitlabConnected,
    jiraChecking,
    jiraConnected,
    linearChecking,
    linearConnected,
    linearSkillInstalled,
    linearSkillLoading,
    linearSkillSettled,
    reviewChecking,
    reviewUnavailable,
    visibleProvidersKey
  ])
}
