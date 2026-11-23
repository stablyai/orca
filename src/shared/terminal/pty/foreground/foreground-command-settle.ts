// Share pane-tracker/opencode-run timing: settle after exec, then retry beyond sequential 3s PowerShell/WMIC enrichment scans.
export const FOREGROUND_COMMAND_READS = { settleMs: 350, retryDelaysMs: [1200, 6000] } as const
