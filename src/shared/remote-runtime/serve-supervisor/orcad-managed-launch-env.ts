/** Managed launches alone enable idle exit and name the activation fence that keeps updates/rollbacks alive.
 * Dependency-free so the orcad launcher can read it. */
export const ORCAD_MANAGED_ACTIVATION_ROOT_ENV = 'ORCA_ORCAD_MANAGED_ACTIVATION_ROOT'

/** Host login env naming a machine's own managed-server data on a shared home; clones copy /etc/machine-id. */
export const ORCA_MACHINE_NAME_ENV = 'ORCA_MACHINE_NAME'

/**
 * A writable directory for the startup-qualified marker of a slot installed read-only or
 * root-owned. The launcher opts in by setting it, so later launches of the same unchanged install
 * skip the disposable preflight. Use one directory per slot.
 */
export const ORCAD_STARTUP_QUALIFICATION_DIR_ENV = 'ORCA_ORCAD_STARTUP_QUALIFICATION_DIR'
