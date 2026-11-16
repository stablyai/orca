/**
 * The ref a create will check out, so a setup approval reads the orca.yaml the new workspace gets
 * instead of the project's own checkout. `branch` is only for explicit reuse of an existing branch.
 */
export type SetupHooksCreateSource =
  | { kind: 'base'; baseBranch?: string }
  | { kind: 'branch'; ref: string; baseBranch?: string }
