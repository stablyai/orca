// Why shared: the CLI refuses a duplicate `orca serve` before exec with the same code the Electron
// main uses, and systemd's RestartPreventExitStatus= keys off it; changing it un-fixes #11935.
export const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = 3
