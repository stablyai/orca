/**
 * With auth state `reconnect-required`: why auth ended the sign-in, when it is worth telling the
 * person apart from "your session expired".
 * `sso-required`: their team turned on single sign-on after they signed in.
 */
export type OrcaProfileReconnectReason = 'sso-required'

/**
 * A sign-in auth refused because the person's team requires single sign-on and they signed in
 * another way (callback `error=sso_required`). The connect result carries it as its `error`.
 */
export const ORCA_CLOUD_AUTH_SSO_REQUIRED_ERROR = 'orca_cloud_auth_sso_required'
