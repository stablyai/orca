import type { PaletteDocument, PaletteTokenAssignment } from './palette-document'

export function assignmentsAreContainerOnly(
  document: PaletteDocument,
  assignments: readonly PaletteTokenAssignment[]
): boolean {
  const tokenRoles = new Map<number, boolean>()
  for (const assignment of assignments) {
    const isContainer = document.fieldById.get(assignment.fieldId)?.role === 'container'
    tokenRoles.set(
      assignment.tokenIndex,
      (tokenRoles.get(assignment.tokenIndex) ?? true) && isContainer
    )
  }
  return tokenRoles.size > 0 && [...tokenRoles.values()].every(Boolean)
}
