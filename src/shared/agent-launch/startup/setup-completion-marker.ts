// The line an observed setup prints when it ends, `<prefix><exit status>`, so the runtime sees it finish.
const SETUP_COMPLETION_PREFIX = '__ORCA_SETUP_COMPLETE__:'

export function setupCompletionMarkerPrefix(completionToken: string): string {
  return `${SETUP_COMPLETION_PREFIX}${completionToken}:`
}
