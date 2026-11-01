// Shared so the terminal toast can recognise main's "this host needs a sign-in" refusal.
export const SSH_SIGN_IN_AWAITED_SUFFIX = 'needs you to sign in. Reconnect to sign in.'
export const SSH_SIGN_IN_CANCELLED_SUFFIX = 'was cancelled. Reconnect to sign in again.'
// Shared so a terminal refused while the user's own connect is still signing in can retry.
export const SSH_CONNECT_IN_PROGRESS_SUFFIX = 'is already in progress'
