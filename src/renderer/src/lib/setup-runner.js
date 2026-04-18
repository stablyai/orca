/**
 * Why WSL check: on Windows, worktrees for WSL repos have setup scripts
 * written as bash .sh files (not .cmd). The terminal for these worktrees
 * runs bash inside WSL, so the command must invoke bash directly with the
 * Linux-native path, not cmd.exe with a Windows path.
 */
export function buildSetupRunnerCommand(runnerScriptPath) {
    if (navigator.userAgent.includes('Windows')) {
        if (isWslUncPath(runnerScriptPath)) {
            const linuxPath = wslUncToLinuxPath(runnerScriptPath);
            return `bash ${quotePosixArg(linuxPath)}`;
        }
        return `cmd.exe /c ${quoteWindowsArg(runnerScriptPath)}`;
    }
    return `bash ${quotePosixArg(runnerScriptPath)}`;
}
/**
 * Check if a path is a WSL UNC path (\\wsl.localhost\... or \\wsl$\...).
 * Lightweight renderer-side check — no Node imports needed.
 */
function isWslUncPath(path) {
    const normalized = path.replace(/\\/g, '/');
    return /^\/\/(wsl\.localhost|wsl\$)\//.test(normalized);
}
/**
 * Convert a WSL UNC path to its Linux equivalent.
 * \\wsl.localhost\Ubuntu\home\user\file → /home/user/file
 */
function wslUncToLinuxPath(windowsPath) {
    const normalized = windowsPath.replace(/\\/g, '/');
    const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/);
    return match?.[2] || '/';
}
function quotePosixArg(value) {
    if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function quoteWindowsArg(value) {
    return `"${value.replace(/"/g, '""')}"`;
}
