export type CodexAccountSelectionTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
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
