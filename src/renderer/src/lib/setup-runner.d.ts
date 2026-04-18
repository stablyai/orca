/**
 * Why WSL check: on Windows, worktrees for WSL repos have setup scripts
 * written as bash .sh files (not .cmd). The terminal for these worktrees
 * runs bash inside WSL, so the command must invoke bash directly with the
 * Linux-native path, not cmd.exe with a Windows path.
 */
export declare function buildSetupRunnerCommand(runnerScriptPath: string): string;
