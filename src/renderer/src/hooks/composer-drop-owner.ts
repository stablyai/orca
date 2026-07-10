export type ComposerDropOwner = symbol

export function isCurrentComposerDropOwner(
  ownerStack: readonly ComposerDropOwner[],
  owner: ComposerDropOwner
): boolean {
  return ownerStack.at(-1) === owner
}
