import type { TabFolderGroup } from '../../../../shared/types'

// Shared default prop values for the folder-group affordances on tab components.
// Stable references so React doesn't treat them as changed props each render.
export const EMPTY_FOLDER_GROUPS: readonly TabFolderGroup[] = []
export const noopTabGroupAction = (): void => {}
export const noopAddToGroupAction = (): void => {}
