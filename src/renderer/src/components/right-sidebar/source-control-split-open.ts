export type SourceControlRowOpenEvent = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function isSourceControlSplitOpenModifier(
  event: SourceControlRowOpenEvent,
  isMac: boolean
): boolean {
  const platformPrimary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return platformPrimary || event.shiftKey || event.altKey
}
