import type { TagOrderBy } from '../ui-chrome-types'

/** The user's tag-section order, passed as one value through the row builders. */
export type TagSectionOrder = {
  by: TagOrderBy
  manual: readonly string[]
}

export const DEFAULT_TAG_SECTION_ORDER: TagSectionOrder = { by: 'name', manual: [] }
