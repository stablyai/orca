// Team lifecycle actions beyond member management: create a team, leave one.

export type OrcaProfileOrgLeaveArgs = {
  orgId: string
}

export type OrcaProfileOrgCreateArgs = {
  name: string
}

export const ORCA_ORG_NAME_MAX_LENGTH = 64

/** 'unsupported': this Orca Cloud auth deployment has no route for the action yet. */
export type OrcaProfileOrgCreateResult =
  | { status: 'created'; orgId: string; name: string }
  | { status: 'unconfigured' | 'reconnect-required' | 'unsupported' | 'rate-limited' }
  | { status: 'invalid' }
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
