export const SETUP_COMPLETION_PREFIX = '__ORCA_SETUP_COMPLETE__:'

export function setupCompletionPrefix(token: string): string {
  return `${SETUP_COMPLETION_PREFIX}${token}:`
}
