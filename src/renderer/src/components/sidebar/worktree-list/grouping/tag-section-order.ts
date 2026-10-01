import type { TagOrderBy } from '../../../../../../shared/ui-chrome-types'

/** The user's tag-section order, passed as one value so row builders keep a single parameter. */
export type TagSectionOrder = {
  by: TagOrderBy
  manual: readonly string[]
}

export const DEFAULT_TAG_SECTION_ORDER: TagSectionOrder = { by: 'name', manual: [] }
