import { useAppStore } from '@/store'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

export type IntegrationStepState = 'active' | 'done' | 'upcoming'

// GitHub/GitLab issues satisfy the task step without a dedicated tracker.
export function deriveIntegrationStepStates(input: {
  reviewConnected: boolean
  trackerConnected: boolean
  codeHostTaskConnected: boolean
}): { review: IntegrationStepState; task: IntegrationStepState; complete: boolean } {
  const review: IntegrationStepState = input.reviewConnected ? 'done' : 'active'
  const taskResolved =
    input.trackerConnected || (input.reviewConnected && input.codeHostTaskConnected)
  const task: IntegrationStepState = taskResolved
    ? 'done'
    : input.reviewConnected
      ? 'active'
      : 'upcoming'
  return { review, task, complete: input.reviewConnected && taskResolved }
}

export function deriveIntegrationFlowState(input: {
  reviewConnected: boolean
  trackerProviderName: 'Linear' | 'Jira' | null
  codeHostTaskProviderName: 'GitHub' | 'GitLab' | null
  trackerChecking: boolean
}): {
  review: IntegrationStepState
  task: IntegrationStepState
  complete: boolean
  taskResolved: boolean
} {
  const trackerConnected = input.trackerProviderName !== null
  // Wait for tracker checks before using the code-host fallback to avoid flashing the wrong completion reason.
  const codeHostTaskReady = input.codeHostTaskProviderName !== null && !input.trackerChecking
  const stepStates = deriveIntegrationStepStates({
    reviewConnected: input.reviewConnected,
    trackerConnected,
    codeHostTaskConnected: codeHostTaskReady
  })
  return {
    ...stepStates,
    taskResolved: stepStates.task === 'done'
  }
}

type CliStatus = {
  installed?: boolean
  authenticated?: boolean
}

type BitbucketStatus = {
  configured?: boolean
  authenticated?: boolean
}

type TokenReviewStatus = {
  configured?: boolean
  authenticated?: boolean
  baseUrl?: string | null
  tokenConfigured?: boolean
}

type ProviderStatusFacts = {
  preflightStatus: {
    gh?: CliStatus
    glab?: CliStatus
    bitbucket?: BitbucketStatus
    azureDevOps?: TokenReviewStatus
    gitea?: TokenReviewStatus
  } | null
  preflightStatusChecked: boolean
  preflightStatusContextKey: string | null
  preflightStatusError: string | null
  preflightStatusLoading: boolean
  expectedPreflightContextKey: string
  linearStatus: { connected?: boolean }
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  jiraStatus: { connected?: boolean }
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  providerRuntimeContextKey: string
}

export type IntegrationConnectionStatus = {
  reviewConnected: boolean
  reviewProviderName: 'GitHub' | 'GitLab' | 'Bitbucket' | 'Azure DevOps' | 'Gitea' | null
  // GitHub/GitLab issues can double as tasks; token/env review providers do not.
  codeHostTaskProviderName: 'GitHub' | 'GitLab' | null
  // Any usable task source, including code-host issues, satisfies this legacy-named field.
  trackerConnected: boolean
  // Dedicated trackers only; code hosts use reviewProviderName.
  trackerProviderName: 'Linear' | 'Jira' | null
  // Include all usable sources, trackers first, for complete connection summaries.
  taskSourceNames: ('Linear' | 'Jira' | 'GitHub' | 'GitLab')[]
  // True while the code-host check is unresolved, stale or loading.
  reviewChecking: boolean
  trackerChecking: boolean
  // Treat unresolved checks as unknown to avoid flashing disconnected summaries.
  checking: boolean
}

function isBitbucketReviewConnected(status: BitbucketStatus | undefined): boolean {
  return status?.configured === true && status.authenticated === true
}

function isAzureDevOpsReviewConfigured(status: TokenReviewStatus | undefined): boolean {
  if (status?.configured !== true) {
    return false
  }
  if (status.tokenConfigured === true && status.baseUrl && status.authenticated !== true) {
    return false
  }
  return true
}

function isGiteaReviewConfigured(status: TokenReviewStatus | undefined): boolean {
  if (status?.configured !== true) {
    return false
  }
  if (status.tokenConfigured === true && status.authenticated !== true) {
    return false
  }
  return true
}

export function deriveIntegrationConnectionStatus(
  facts: ProviderStatusFacts
): IntegrationConnectionStatus {
  const preflightCurrent = facts.preflightStatusContextKey === facts.expectedPreflightContextKey
  const reviewChecking =
    facts.preflightStatusLoading || !facts.preflightStatusChecked || !preflightCurrent
  const reviewReadyForConnection = !reviewChecking && facts.preflightStatusError === null
  const githubConnected =
    reviewReadyForConnection &&
    facts.preflightStatus?.gh?.installed === true &&
    facts.preflightStatus.gh.authenticated === true
  const gitlabConnected =
    reviewReadyForConnection &&
    facts.preflightStatus?.glab?.installed === true &&
    facts.preflightStatus.glab.authenticated === true
  const bitbucketConnected =
    reviewReadyForConnection && isBitbucketReviewConnected(facts.preflightStatus?.bitbucket)
  const azureDevOpsConnected =
    reviewReadyForConnection && isAzureDevOpsReviewConfigured(facts.preflightStatus?.azureDevOps)
  const giteaConnected =
    reviewReadyForConnection && isGiteaReviewConfigured(facts.preflightStatus?.gitea)

  const linearStatusCurrent = facts.linearStatusContextKey === facts.providerRuntimeContextKey
  const jiraStatusCurrent = facts.jiraStatusContextKey === facts.providerRuntimeContextKey
  const linearChecking = !linearStatusCurrent || !facts.linearStatusChecked
  const jiraChecking = !jiraStatusCurrent || !facts.jiraStatusChecked
  const linearConnected =
    !linearChecking && linearStatusCurrent && facts.linearStatus.connected === true
  const jiraConnected = !jiraChecking && jiraStatusCurrent && facts.jiraStatus.connected === true

  const reviewProviderName = githubConnected
    ? 'GitHub'
    : gitlabConnected
      ? 'GitLab'
      : bitbucketConnected
        ? 'Bitbucket'
        : azureDevOpsConnected
          ? 'Azure DevOps'
          : giteaConnected
            ? 'Gitea'
            : null
  const codeHostTaskProviderName = githubConnected ? 'GitHub' : gitlabConnected ? 'GitLab' : null
  const trackerProviderName = linearConnected ? 'Linear' : jiraConnected ? 'Jira' : null
  const taskSourceNames: IntegrationConnectionStatus['taskSourceNames'] = [
    ...(linearConnected ? (['Linear'] as const) : []),
    ...(jiraConnected ? (['Jira'] as const) : []),
    ...(githubConnected ? (['GitHub'] as const) : []),
    ...(gitlabConnected ? (['GitLab'] as const) : [])
  ]
  const hasUsableTaskSource = taskSourceNames.length > 0
  // Parent readiness needs one task source; the code-host acknowledgement waits for trackers to choose accurate copy.
  const trackerChecking = trackerProviderName === null && (linearChecking || jiraChecking)

  return {
    reviewConnected:
      githubConnected ||
      gitlabConnected ||
      bitbucketConnected ||
      azureDevOpsConnected ||
      giteaConnected,
    reviewProviderName,
    codeHostTaskProviderName,
    trackerConnected: hasUsableTaskSource,
    trackerProviderName,
    taskSourceNames,
    reviewChecking,
    trackerChecking,
    checking: !hasUsableTaskSource && (reviewChecking || trackerChecking)
  }
}

export function useIntegrationConnectionStatus(): IntegrationConnectionStatus {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const settings = useAppStore((s) => s.settings)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )

  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)

  return deriveIntegrationConnectionStatus({
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusError,
    preflightStatusLoading,
    expectedPreflightContextKey,
    linearStatus,
    linearStatusChecked,
    linearStatusContextKey,
    jiraStatus,
    jiraStatusChecked,
    jiraStatusContextKey,
    providerRuntimeContextKey
  })
}
