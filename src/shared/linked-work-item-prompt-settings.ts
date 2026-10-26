import type { GlobalSettings } from './global-settings-types'
import type { Project } from './project-types'
import { projectMatchesRepo } from './project-repo-match'

export function normalizeLinkedWorkItemPromptTemplate(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function getLinkedWorkItemPromptTemplate(
  state: {
    settings?: Pick<GlobalSettings, 'linkedWorkItemPromptTemplate'> | null
    projects?: readonly Pick<Project, 'id' | 'sourceRepoIds' | 'linkedWorkItemPromptTemplate'>[]
  },
  repoId?: string
): string | undefined {
  const project = repoId
    ? state.projects?.find((candidate) => projectMatchesRepo(candidate, repoId))
    : undefined
  return (
    normalizeLinkedWorkItemPromptTemplate(project?.linkedWorkItemPromptTemplate)?.trim() ||
    normalizeLinkedWorkItemPromptTemplate(state.settings?.linkedWorkItemPromptTemplate)?.trim() ||
    undefined
  )
}

export function renderLinkedWorkItemPromptTemplate(
  template: string | undefined,
  url: string
): string | null {
  return template?.trim() ? template.replace(/\{\{url\}\}/g, () => url.trim()).trim() : null
}
