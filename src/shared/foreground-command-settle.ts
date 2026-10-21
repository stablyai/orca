// Why: settle after exec, then place the final generic retry beyond sequential
// 3s PowerShell and WMIC enrichment scans. Shared by the renderer's pane tracker
// and main's `opencode run` producer so both read a command's foreground alike.
export const FOREGROUND_COMMAND_READS = { settleMs: 350, retryDelaysMs: [1200, 6000] } as const
