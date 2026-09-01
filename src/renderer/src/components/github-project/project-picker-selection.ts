import type { GitHubProjectOwnerType } from '../../../../shared/github/project-types'

export type ResolvedProjectSelection = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  host?: string
  viewId?: string
}

export type ProjectPickerChoice = {
  owner: string
  ownerType: GitHubProjectOwnerType
  number: number
  host?: string
  title?: string
  viewNumber?: number
}
