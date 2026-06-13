export type SourceControlRowOpenEvent = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  openAsPermanent?: boolean
}

type SourceControlOpenModifierKeys = Pick<
  SourceControlRowOpenEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

export function isSourceControlSplitOpenModifier(
  event: SourceControlRowOpenEvent,
  isMac: boolean
): boolean {
  const platformPrimary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return platformPrimary || event.shiftKey || event.altKey
}

export function shouldOpenSourceControlRowAsPreview(
  event: SourceControlRowOpenEvent | undefined,
  targetGroupId: string | undefined
): boolean {
  return !targetGroupId && event?.openAsPermanent !== true
}

export function toPermanentSourceControlRowOpenEvent(
  event: SourceControlOpenModifierKeys
): SourceControlRowOpenEvent {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    openAsPermanent: true
  }
}
