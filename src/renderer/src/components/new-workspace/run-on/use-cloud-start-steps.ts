// The setup panel's rows for the composer: billing access (account, trial or plan), the GitHub
// repository check (D1–D3) and the agent row, or the setup session's own rows once one is open.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { orcaCloudGitHubSetupRow } from '@/lib/orca-cloud/orca-cloud-github-setup-row'
import { useOrcaCloudRepoAccess } from '@/lib/orca-cloud/use-orca-cloud-repo-access'
import {
  getCloudSetupSessionRevision,
  readCloudSetupSession,
  subscribeCloudSetupSessionRevision
} from '@/lib/orca-cloud/cloud-setup-session-seam'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { deriveCloudSetupSteps, type CloudSetupStep } from './cloud-start-model'
import { toGitHubSetupStep } from './cloud-start-github-step'

function agentStep(step: CloudSetupStep, agent: string | null, signedOut: boolean): CloudSetupStep {
  if (step.id !== 'agent' || !agent) {
    return step
  }
  const name = getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
  // Agent accounts v4: sign in once via the Orca account (S0), never per sandbox (G).
  return {
    ...step,
    detail: signedOut
      ? translate(
          'components.newWorkspace.cloudSetup.agentSetUpAfterSignIn',
          '{{agent}}: set up once in Settings → Agent accounts after you sign in',
          { agent: name }
        )
      : translate(
          'components.newWorkspace.cloudSetup.agentSetUpOnce',
          '{{agent}}: set up once in Settings → Agent accounts',
          { agent: name }
        )
  }
}

/** Composer-only wording on derived rows: the agent's name. */
export function decorateCloudSetupStep(
  step: CloudSetupStep,
  agent: string | null,
  signedOut: boolean
): CloudSetupStep {
  return agentStep(step, agent, signedOut)
}

export function useCloudStartSteps({
  availability,
  access,
  repoId,
  agent,
  cloudSelected,
  setupSessionId,
  githubOverride = null,
  onGranted
}: {
  availability: OrcaCloudAvailability
  access: OrcaCloudRunTargetAccess
  repoId: string
  agent: string | null
  cloudSelected: boolean
  setupSessionId: string | null
  /** A cloud-only repository listed from the team's installations: its GitHub row is done (D4). */
  githubOverride?: CloudSetupStep | null
  /** A repository that was waiting on GitHub (install or an owner's approval) became reachable. */
  onGranted?: (repoName: string) => void
}) {
  const grantedRef = useRef(onGranted)
  const repoNameRef = useRef('')
  useEffect(() => {
    grantedRef.current = onGranted
  }, [onGranted])
  const repoAccess = useOrcaCloudRepoAccess(repoId, {
    enabled:
      cloudSelected &&
      !githubOverride &&
      availability !== 'unavailable' &&
      availability !== 'unreachable',
    // The hook only polls while the repository is waiting on GitHub.
    poll: cloudSelected,
    onGranted: () => grantedRef.current?.(repoNameRef.current),
    ...(setupSessionId ? { setupSessionId } : {})
  })
  const { state, access: grant, repoName, owner, loading, openInstall } = repoAccess
  useEffect(() => {
    repoNameRef.current = repoName
  }, [repoName])
  const github = useMemo(
    () =>
      cloudSelected
        ? toGitHubSetupStep(
            orcaCloudGitHubSetupRow({ state, access: grant, repoName, owner, loading }),
            { loading, openUrl: openAppHttpLink }
          )
        : null,
    [cloudSelected, grant, loading, owner, repoName, state]
  )
  // Subscribing re-renders on each poll; the read itself is a cheap synchronous lookup.
  useSyncExternalStore(subscribeCloudSetupSessionRevision, getCloudSetupSessionRevision)
  const session = readCloudSetupSession(setupSessionId)
  const signedOut = availability === 'needs-sign-in' || access.state === 'signed-out'
  const steps = useMemo(
    () =>
      (
        session?.steps ??
        deriveCloudSetupSteps({ availability, access, github: githubOverride ?? github })
      ).map((step) => decorateCloudSetupStep(step, agent, signedOut)),
    [access, agent, availability, github, githubOverride, session?.steps, signedOut]
  )
  return { steps, session, openInstall }
}
