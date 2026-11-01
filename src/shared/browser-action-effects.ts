import type { BrowserActionEffects } from './runtime-browser-contracts'

/** The `effects` an agent's page action result carries, if any. */
export function readBrowserActionEffects(result: unknown): BrowserActionEffects | undefined {
  if (typeof result !== 'object' || result === null || !('effects' in result)) {
    return undefined
  }
  const { effects } = result
  return isBrowserActionEffects(effects) ? effects : undefined
}

function isBrowserActionEffects(value: unknown): value is BrowserActionEffects {
  return typeof value === 'object' && value !== null && 'settled' in value
}
