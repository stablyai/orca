import type { Project, ProjectHostSetup } from './project-types'

type IdentityInput = {
  projectId?: string
  repoId: string
  hostId?: string
  projects: readonly Pick<Project,'id'|'sourceRepoIds'>[]
  setups: readonly Pick<ProjectHostSetup,'projectId'|'repoId'|'hostId'>[]
  fallback?: string
}

/** Reuse Orca's host-aware catalog. Never map a project from a display name or Git branch. */
export function resolveHubProjectId(input: IdentityInput): string | null {
  const ids=new Set(input.projects.map(project=>project.id))
  if(input.projectId && ids.has(input.projectId)) return input.projectId
  const matches=new Set(input.setups
    .filter(setup=>setup.repoId===input.repoId && (!input.hostId||setup.hostId===input.hostId))
    .map(setup=>setup.projectId).filter(id=>ids.has(id)))
  if(matches.size===1)return Array.from(matches)[0]
  if(matches.size>1)return null
  const candidates=input.projects.filter(project=>project.sourceRepoIds.includes(input.repoId))
  if(candidates.length===1)return candidates[0].id
  if(candidates.length>1)return null
  return input.fallback??null
}
