// The setup panel's rows for the composer: billing access (account, trial or plan), the GitHub
// repository check (D1–D3) and the agent row, or the setup session's own rows once one is open.
import { useEffect, useMemo, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { orcaCloudGitHubSetupRow } from '@/lib/orca-cloud/orca-cloud-github-setup-row'
import { useOrcaCloudRepoAccess } from '@/lib/orca-cloud/use-orca-cloud-repo-access'
import { useCloudSetupSession } from '@/lib/orca-cloud/cloud-setup-session-seam'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import {
  deriveCloudSetupSteps,
  withReachableGitHub,
  type CloudSetupStep
} from './cloud-start-model'
import { cloudStartAgentStep } from './cloud-start-agent-step'
import {
  orcaCloudAgentSetupRow,
  type OrcaCloudAgentSetupRowModel
} from '@/lib/orca-cloud/orca-cloud-agent-setup-row'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { noteComposerAgentCoverage } from '@/lib/orca-cloud/cloud-first-start-agent-coverage'
import { toGitHubSetupStep } from './cloud-start-github-step'

/** Composer-only wording on derived rows: the Agent row (G) from the Orca account's agent setup. */
export function decorateCloudSetupSteps(
  steps: readonly CloudSetupStep[],
  agentRow: OrcaCloudAgentSetupRowModel
): CloudSetupStep[] {
  const out: CloudSetupStep[] = []
  for (const step of steps) {
    if (step.id !== 'agent') {
      out.push(step)
      continue
    }
    const decorated = cloudStartAgentStep(step, agentRow, translate)
    if (decorated) {
      out.push(decorated)
    }
  }
  return out
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
  // Re-renders on each poll with that poll's snapshot.
  const session = useCloudSetupSession(setupSessionId)
  const signedOut = availability === 'needs-sign-in' || access.state === 'signed-out'
  const accounts = useOrcaCloudAgentAccounts(cloudSelected && !signedOut)
  const agentRow = useMemo(
    () =>
      orcaCloudAgentSetupRow({
        agent,
        access: signedOut ? { state: 'signed-out' } : access,
        accounts
      }),
    [access, accounts, agent, signedOut]
  )
  useEffect(() => {
    if (cloudSelected) {
      noteComposerAgentCoverage(agentRow)
    }
  }, [agentRow, cloudSelected])
  const steps = useMemo(
    () =>
      decorateCloudSetupSteps(
        session
          ? withReachableGitHub(session.steps, Boolean(githubOverride) || state === 'ok')
          : deriveCloudSetupSteps({ availability, access, github: githubOverride ?? github }),
        agentRow
      ),
    [access, agentRow, availability, github, githubOverride, session, state]
  )
  return { steps, session, openInstall }
}
