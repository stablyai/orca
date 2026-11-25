/**
 * The ref a create will check out, so a setup approval reads the orca.yaml the new workspace gets
 * instead of the project's own checkout. `branch` is only for explicit reuse of an existing branch.
 */
export type SetupHooksCreateSource =
  | { kind: 'base'; baseBranch?: string }
  | { kind: 'branch'; ref: string; baseBranch?: string }

/**
 * Only explicit reuse checks out the named branch; every other create starts from the base. A VM
 * create picks its base after this check, so it keeps reading the project checkout.
 */
export function setupHooksCreateSource(request: {
  branchIntent?: string
  branchNameOverride?: string
  baseBranch?: string
  ephemeralVmRecipe?: unknown
}): SetupHooksCreateSource | undefined {
  if (request.ephemeralVmRecipe) {
    return undefined
  }
  return request.branchIntent === 'open-existing-v2' && request.branchNameOverride
    ? { kind: 'branch', ref: request.branchNameOverride, baseBranch: request.baseBranch }
    : { kind: 'base', baseBranch: request.baseBranch }
}
