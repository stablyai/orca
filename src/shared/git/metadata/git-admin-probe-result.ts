export const GIT_ADMIN_PROBE_UNAVAILABLE = Symbol('git-admin-probe-unavailable')
export type GitAdminProbeResult = string | null | typeof GIT_ADMIN_PROBE_UNAVAILABLE
