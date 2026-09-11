export type QuickNote = {
  id: string
  label: string
  /** Plain multi-line text copied verbatim to the clipboard when the note is picked. */
  body: string
}
