/** What the window tells the user about profile saving; null while saving works normally. */
export type ProfileStateSaveNotice = 'slow' | 'failing' | 'disk-full' | null

/** IPC payloads are untrusted; anything unrecognized means no notice. */
export function parseProfileStateSaveNotice(value: unknown): ProfileStateSaveNotice {
  return value === 'slow' || value === 'failing' || value === 'disk-full' ? value : null
}
