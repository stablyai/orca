const messages = new Map<string, string>([
  [
    'github_participant_identity_required',
    'This project requires a GitHub member identity. Use an enrolled paired device or an Orca-launched member session.'
  ],
  [
    'github_participant_missing',
    'This device has no server member assignment. Ask the server owner to enroll it.'
  ],
  [
    'github_participant_account_missing',
    'Select an assigned GitHub account in this project’s member account settings.'
  ],
  [
    'github_participant_account_not_allowed',
    'The selected GitHub account is no longer assigned to this member. Ask the server owner to review the account assignment.'
  ],
  [
    'github_participant_owner_required',
    'Only the server owner can manage members, device assignments, or account permissions. Run this action on the server.'
  ],
  [
    'github_participant_owner_mismatch',
    'The GitHub operation belongs to another member, project, or session. Start a new operation from the intended member session.'
  ],
  [
    'github_participant_device_required',
    'Choose a personal GitHub account from an enrolled paired device. Agent jobs retain their accepted account.'
  ],
  [
    'github_participant_device_revoked',
    'This device is unavailable or its server access was revoked. Ask the server owner to review its enrollment.'
  ],
  [
    'github_participant_device_already_assigned',
    'This device already belongs to another member. The server owner must remove that assignment first.'
  ],
  [
    'github_participant_delegated_device',
    'Assign the parent desktop device; its delegated phone uses the same member.'
  ],
  [
    'github_participant_registry_unavailable',
    'GitHub member storage could not be read or saved safely. Repair the server’s member storage before retrying.'
  ],
  [
    'github_participant_registry_permissions',
    'GitHub member storage permissions could not be secured. Repair the server’s profile directory before retrying.'
  ],
  [
    'github_participant_mode_disabled',
    'GitHub member accounts are not enabled for this project. Ask the server owner to enable them.'
  ],
  [
    'github_participant_repo_disabled',
    'GitHub member accounts were disabled for this project. Start a new operation after the server owner reviews its account policy.'
  ],
  [
    'github_participant_repo_required',
    'Choose a project for this GitHub operation so Orca can select your member account.'
  ],
  [
    'github_participant_job_proof_invalid',
    'Orca could not verify this agent’s current member session. Relaunch it from an enrolled member device.'
  ],
  [
    'github_participant_jobs_unavailable',
    'GitHub job ownership storage is unavailable. Repair the server’s profile storage before launching member jobs.'
  ],
  [
    'github_participant_jobs_permissions',
    'GitHub job ownership storage permissions could not be secured. Repair the server’s profile directory.'
  ]
])

export function gitHubParticipantFailure(code: string): { code: string; message: string } | null {
  const message = messages.get(code)
  return message ? { code, message } : null
}
