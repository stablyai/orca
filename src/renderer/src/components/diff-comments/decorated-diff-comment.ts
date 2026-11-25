import type { DiffComment } from '../../../../shared/file-review/diff-comment-types'

export type DecoratedDiffComment = DiffComment & {
  author?: string
  authorAvatarUrl?: string
  createdAtLabel?: string
  url?: string
  canDelete?: boolean
  canEdit?: boolean
}
