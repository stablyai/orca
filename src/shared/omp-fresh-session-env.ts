// Why: Orca's explicit "new OMP tab" launch must bypass OMP's autoResume setting
// without disabling session persistence or changing typed `omp` commands forever.
export const ORCA_OMP_FORCE_NEW_SESSION_ENV = 'ORCA_OMP_FORCE_NEW_SESSION'

// Why: renderer startup commands can pass an explicit `--session-dir` before
// the shell wrapper runs. Main fills this host-local path after installing the
// managed OMP environment, scoped by Orca worktree to prevent cross-worktree
// auto-resume bleed.
export const ORCA_OMP_FRESH_SESSION_DIR_ENV = 'ORCA_OMP_FRESH_SESSION_DIR'
