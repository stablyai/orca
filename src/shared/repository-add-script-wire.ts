export const REPOSITORY_ADD_SCRIPT_DECIDE_METHOD = 'repositoryAddScript.decide'
export const REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD = 'repositoryAddScript.outcome'

// A run may take up to 120s plus cleanup; a shorter sender deadline would hide a live run as a failure.
export const REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS = 150_000
