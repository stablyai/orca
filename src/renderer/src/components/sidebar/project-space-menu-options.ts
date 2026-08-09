import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { DEFAULT_SPACE_ID, hasCustomSpaces, resolveSpaceId } from '../../../../shared/spaces'
import type { Space } from '../../../../shared/types'

export type ProjectSpaceMenuOption = {
  spaceId: string
  targetSpaceId: string | null
  emoji: string | null
  name: string
  selected: boolean
}

const NO_SPACE_OPTIONS: readonly ProjectSpaceMenuOption[] = []

export function getProjectSpaceMenuOptions(
  spaces: readonly Space[],
  repoSpaceId: string | null | undefined,
  hostId?: ExecutionHostId
): readonly ProjectSpaceMenuOption[] {
  // Why: runtime-owned catalogs are host-managed and do not persist desktop Space membership.
  if (!hasCustomSpaces(spaces) || parseExecutionHostId(hostId)?.kind === 'runtime') {
    return NO_SPACE_OPTIONS
  }
  const currentSpaceId = resolveSpaceId(repoSpaceId)
  return spaces.map((space) => ({
    spaceId: space.id,
    targetSpaceId: space.id === DEFAULT_SPACE_ID ? null : space.id,
    emoji: space.emoji,
    name: space.name,
    selected: space.id === currentSpaceId
  }))
}
