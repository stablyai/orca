import { z } from 'zod'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { PROJECT_COORDINATION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { getProjectSetupRuntimeTarget } from '@/store/projects/project-host-routing'

export const ProjectContext = z.object({
  id: z.string(),
  displayName: z.string(),
  sourceRepoIds: z.array(z.string()),
  coordination: z
    .object({
      goal: z.string(),
      instructions: z.string(),
      revision: z.number().int().nonnegative()
    })
    .optional()
})
export type ProjectContext = z.infer<typeof ProjectContext>
export function projectHomeTarget(
  repo: Repo,
  setups: readonly ProjectHostSetup[]
): RuntimeClientTarget {
  const hostId = getRepoExecutionHostId(repo)
  const matches = setups.filter(
    (setup) =>
      setup.repoId === repo.id &&
      setup.path === repo.path &&
      (setup.executionHostId ?? setup.hostId) === hostId
  )
  const owners = new Set(matches.map((setup) => setup.runtimeOwnerEnvironmentId ?? 'local'))
  if (owners.size > 1) {
    throw new Error('This project has multiple runtime owners. Select its host again.')
  }
  const owner = matches[0]?.runtimeOwnerEnvironmentId
  return owner
    ? { kind: 'environment', environmentId: owner }
    : getProjectSetupRuntimeTarget(hostId)
}

export async function assertProjectHomeCapability(target: RuntimeClientTarget) {
  const revision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(target.environmentId)
      : undefined
  const status = z
    .object({ runtimeId: z.string(), capabilities: z.array(z.string()).optional() })
    .parse(
      await callRuntimeRpc(target, 'status.get', undefined, {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: revision
      })
    )
  if (!status.capabilities?.includes(PROJECT_COORDINATION_RUNTIME_CAPABILITY)) {
    throw new Error('Update Orca on this project’s server to use Project home.')
  }
  // Pin the follow-up to the server that proved support, even if its pairing is replaced.
  return {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: revision,
    expectedEnvironmentRuntimeId: status.runtimeId
  }
}

export async function loadProject(
  target: RuntimeClientTarget,
  repoId: string
): Promise<ProjectContext> {
  const options = await assertProjectHomeCapability(target)
  const response = z
    .object({ projects: z.array(ProjectContext) })
    .parse(await callRuntimeRpc(target, 'project.list', undefined, options))
  const matches = response.projects.filter((project) => project.sourceRepoIds.includes(repoId))
  if (matches.length !== 1) {
    throw new Error('Project is unavailable on the selected runtime. Refresh the project list.')
  }
  return matches[0]!
}

export async function saveProject(
  target: RuntimeClientTarget,
  project: ProjectContext,
  goal: string,
  instructions: string,
  expectedRevision = project.coordination?.revision ?? 0
) {
  const options = await assertProjectHomeCapability(target)
  const response = z.object({ project: ProjectContext.nullable() }).parse(
    await callRuntimeRpc(
      target,
      'project.update',
      {
        projectId: project.id,
        updates: {
          coordination: { goal, instructions, expectedRevision }
        }
      },
      options
    )
  )
  if (!response.project) {
    throw new Error('Project identity changed. Load latest saved context before saving again.')
  }
  return response.project
}
