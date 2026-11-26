/** A key file found already in Downloads, for "Use this file". */
export type GoogleSetupFoundKey = { name: string; text: string; modifiedAt: number }

/**
 * A Google app file's text, read on this desktop, or why it could not be. `unwatchable`: Downloads
 * can't be watched (no folder, or no watches left), so waiting again won't help.
 */
export type GoogleSetupFileResult =
  | { ok: true; text: string }
  | { ok: false; message: string; unwatchable?: true }
