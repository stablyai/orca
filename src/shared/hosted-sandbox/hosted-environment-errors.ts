// Friendly copy for team-environment failures (glossary: team, sandbox, workspace). Shared by the desktop IPC (UI) and the CLI so an agent
// running `orca cloud env build` reads the same sentence a person sees in Settings.
import type { OrcaCloudEnvironmentError } from './hosted-environment-api'

const REASON_MESSAGES: Record<string, string> = {
  admin_required: 'Only owners and admins can change the environment. Ask an owner or admin.',
  stale_revision: 'Someone else saved changes. Reload to see them.',
  build_in_progress: 'A build is already running for this environment. Wait for it or cancel it.',
  build_not_activatable:
    'This build cannot be made active: only succeeded builds that still have their snapshot can.',
  build_finishing: 'The build is finishing and can no longer be canceled.',
  concurrent_transition: 'The build changed state at the same moment; reload and try again.',
  name_taken: 'Another environment already uses that name.',
  environment_limit: 'Your team has reached its environment limit.',
  no_repos: 'Add at least one repository before building.',
  repo_not_github: 'Repositories must be GitHub repositories (owner/repo or a github.com URL).',
  repo_duplicate: 'That repository is listed twice.',
  build_unavailable: 'That build is no longer available.'
}

const CODE_MESSAGES: Record<string, string> = {
  not_configured: 'Orca Cloud is not set up in this build of Orca.',
  unauthorized: 'Sign in to Orca to use Orca Cloud.',
  forbidden: 'You don’t have permission to do that in Orca Cloud.',
  not_found: 'That environment or build no longer exists.',
  conflict: 'That conflicts with a change someone else made; reload and try again.',
  invalid_request: 'Orca Cloud rejected the request as invalid.',
  invalid_json: 'Orca Cloud rejected the request as invalid.',
  entitlement_denied: 'Your plan does not include this. Check Plan & billing.',
  timeout: 'Orca Cloud did not answer in time. Try again.',
  aborted: 'The request was canceled.',
  invalid_response: 'Orca Cloud returned an unexpected response.',
  provider_unavailable: 'Orca Cloud couldn’t start a sandbox right now. Try again in a moment.',
  billing_unavailable: 'Orca Cloud could not check your plan right now. Try again in a moment.',
  unavailable: 'Could not reach Orca Cloud. Try again in a moment.'
}

/** Entitlement reasons arrive under `forbidden`; anything not admin_required is a plan/limit refusal. */
const ENTITLEMENT_FORBIDDEN_MESSAGE =
  'Your plan does not allow this right now (check Plan & billing or your usage limits).'

export function hostedEnvironmentErrorMessage(code: string, reason?: string | null): string {
  if (reason && REASON_MESSAGES[reason]) {
    return REASON_MESSAGES[reason]
  }
  if (code === 'invalid_request' && reason) {
    // The field name stays in `reason` (shown by Copy logs / the CLI's --json), not in the sentence.
    return 'Orca Cloud rejected one of the environment settings. Check them and try again.'
  }
  if (code === 'forbidden' && reason) {
    return ENTITLEMENT_FORBIDDEN_MESSAGE
  }
  return CODE_MESSAGES[code] ?? CODE_MESSAGES.unavailable
}

export function hostedEnvironmentError(
  code: string,
  reason?: string | null
): OrcaCloudEnvironmentError {
  return {
    code,
    ...(reason ? { reason } : {}),
    message: hostedEnvironmentErrorMessage(code, reason)
  }
}
