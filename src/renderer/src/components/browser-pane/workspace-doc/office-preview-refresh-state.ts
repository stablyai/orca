/**
 * What the re-render control looks like, and whether it means anything.
 *
 * Pure and separately tested on purpose: this is exactly the logic that rots into "the button is
 * sometimes a lie" when it lives inside a component and each new branch adds one more condition
 * nobody re-reads.
 */
export type OfficeRefreshState =
  /** Re-rendering cannot change the outcome — an unrenderable format, or a document over the cap. */
  | 'hidden'
  /** There is no addressable document to re-read. */
  | 'disabled'
  /** Nothing is known to have changed, but a manual re-render still works. */
  | 'idle'
  /** A change was reported and has not been consumed yet. */
  | 'updated'

export type OfficeRefreshInputs = {
  /** False for a format we do not render at all. */
  renderable: boolean
  /** True once a render has been refused in a way a retry cannot fix. */
  terminallyRefused: boolean
  /** False while the document has no resolvable owner or path. */
  addressable: boolean
  /** Set by the `files.watch` stream when the document changed on disk. */
  changedOnDisk: boolean
  /** True while a render or refresh is in flight; the control stays visible but inert. */
  busy: boolean
}

export function officeRefreshState(inputs: OfficeRefreshInputs): OfficeRefreshState {
  if (!inputs.renderable || inputs.terminallyRefused) {
    return 'hidden'
  }
  if (!inputs.addressable || inputs.busy) {
    return 'disabled'
  }
  return inputs.changedOnDisk ? 'updated' : 'idle'
}

export function isOfficeRefreshClickable(state: OfficeRefreshState): boolean {
  return state === 'idle' || state === 'updated'
}

/**
 * Refusals a retry cannot fix.
 *
 * Deliberately short: a missing binary is NOT here, because installing it and pressing Retry is
 * exactly the recovery the missing-binary notice offers. Only outcomes that would be identical on
 * the next attempt earn a hidden control.
 */
export function isTerminalOfficeRefusal(code: string | null): boolean {
  return code === 'OFFICECLI_UNSUPPORTED_FORMAT' || code === 'OFFICE_RENDER_TOO_LARGE'
}
