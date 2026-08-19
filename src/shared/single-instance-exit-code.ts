// Why: systemd RestartPreventExitStatus= keys off this; changing it silently un-fixes #11935.
// Shared so the CLI can refuse a duplicate serve without importing a main-process module.
export const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = 3
