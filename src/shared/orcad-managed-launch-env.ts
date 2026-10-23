/**
 * Set only by a client's managed launch. Enables idle exit and names the host's activation
 * fence, so an update or rollback in flight keeps the server up. User-started servers never
 * carry it. Dependency-free so the orcad launcher can read it.
 */
export const ORCAD_MANAGED_ACTIVATION_ROOT_ENV = 'ORCA_ORCAD_MANAGED_ACTIVATION_ROOT'
