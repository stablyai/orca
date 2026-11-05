export type CodexAccountSelectionTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  /** A launch's workspace, whose project may pin a host account; lane keys ignore it. */
  worktreeId?: string
  /** The project's pin when this process cannot read the project, such as a WSL host's. */
  projectAccountId?: string
}

export type NormalizedCodexAccountSelectionTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export function normalizeCodexAccountSelectionTarget(
  target?: CodexAccountSelectionTarget | null
): NormalizedCodexAccountSelectionTarget {
  if (target?.runtime === 'wsl') {
    return {
      runtime: 'wsl',
      wslDistro: normalizeWslDistro(target.wslDistro)
    }
  }
  return { runtime: 'host', wslDistro: null }
}

/** Stable identifier for the selection lane a launch resolves its account from. */
export function getCodexSelectionLaneKey(target?: CodexAccountSelectionTarget | null): string {
  const normalized = normalizeCodexAccountSelectionTarget(target)
  return normalized.runtime === 'host' ? 'host' : `wsl:${getWslSelectionKey(normalized.wslDistro)}`
}

export function getWslSelectionKey(wslDistro: string | null | undefined): string {
  return normalizeWslDistro(wslDistro) ?? '__default__'
}

function normalizeWslDistro(wslDistro: string | null | undefined): string | null {
  const trimmed = wslDistro?.trim()
  return trimmed ? trimmed : null
}
