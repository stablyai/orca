export type AntigravityStatusLineStatus = {
  state: 'installed' | 'not_installed' | 'error' | 'unsupported'
  configPath: string
  detail: string | null
}

/** Show Antigravity quota read from agy's own status line in Orca terminals; Orca never runs agy for it. */
export type AntigravityStatusLineUsageSettings = { antigravityStatusLineUsageEnabled: boolean }
