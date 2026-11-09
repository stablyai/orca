// Team lifecycle actions beyond member management: create a team, leave one.

export type OrcaProfileOrgLeaveArgs = {
  orgId: string
}

export type OrcaProfileOrgCreateArgs = {
  name: string
}

export const ORCA_ORG_NAME_MAX_LENGTH = 64
/** The sign-in provider's rule for team names: letters, digits, spaces and underscores. */
export const ORCA_ORG_NAME_PATTERN = /^[A-Za-z0-9_ ]{1,64}$/

export function isValidOrgName(name: string): boolean {
  return ORCA_ORG_NAME_PATTERN.test(name.trim())
}

/** 'unsupported': this Orca Cloud auth deployment has no route for the action yet. */
export type OrcaProfileOrgCreateResult =
  | { status: 'created'; orgId: string; name: string }
  | { status: 'unconfigured' | 'reconnect-required' | 'unsupported' | 'rate-limited' }
  | { status: 'invalid' }
  /** Another team already uses this name. */
  | { status: 'name-taken' }
  | { status: 'failed'; error: string }

export type OrcaOrgInviteConflictReason = 'already_member' | 'already_invited'
export type OrcaOrgMutationInvalidReason =
  | 'cannot_change_own_role'
  | 'cannot_remove_self'
  | 'last_owner'

export type OrcaProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | {
      status:
        | 'unconfigured'
        | 'reconnect-required'
        | 'forbidden'
        | 'not-found'
        | 'unsupported'
        | 'rate-limited'
    }
  | { status: 'conflict'; reason: OrcaOrgInviteConflictReason }
  | { status: 'invalid'; reason: OrcaOrgMutationInvalidReason }
  | { status: 'failed'; error: string }
