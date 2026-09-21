/** Returns true when a late pane callback would restore an older PTY over the live binding. */
export function shouldIgnoreStalePanePtyLayoutBinding(args: {
  existingPtyId: string | null | undefined
  nextPtyId: string
  tabPtyId: string | null | undefined
}): boolean {
  return Boolean(
    args.existingPtyId &&
    args.existingPtyId !== args.nextPtyId &&
    args.tabPtyId &&
    args.tabPtyId === args.existingPtyId
  )
}
