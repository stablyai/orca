/**
 * With auth state `reconnect-required`: why auth ended the sign-in, when it is worth telling the
 * person apart from "your session expired".
 * `sso-required`: their team turned on single sign-on after they signed in.
 */
export type OrcaProfileReconnectReason = 'sso-required'
