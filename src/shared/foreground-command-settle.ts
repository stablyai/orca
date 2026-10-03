// Why: settle after exec, then place the final generic retry beyond sequential
// 3s PowerShell and WMIC enrichment scans.
export const FOREGROUND_COMMAND_READS = { settleMs: 350, retryDelaysMs: [1200, 6000] } as const
