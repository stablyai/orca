import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat-session-option-state'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const CODEX_FOOTER =
  /^([A-Za-z][\w.\-/]*(?:\s+[A-Za-z0-9][\w.\-/]*)*)\s+(default|minimal|low|medium|high|xhigh|max|ultra)\s*·\s*(?:~[/\\]|[/\\]|[A-Za-z]:[/\\])/i

/** Codex keeps its live model in the footer even when the startup frame scrolls away. */
export function readCodexSessionOptionsFromTerminalScreen(
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const footer = lines
    .slice(-8)
    .toReversed()
    .map((line) => line.match(CODEX_FOOTER))
    .find(Boolean)
  if (!footer) {
    return null
  }
  const [, label, effort] = footer
  const catalog = getAgentSessionOptionCatalog('codex')
  if (!catalog || !label || /^loading$/i.test(label)) {
    return null
  }
  const model =
    matchNativeChatCatalogModelId({ ...catalog, models: [...(models ?? catalog.models)] }, label) ??
    label
  return effort === 'default' ? { model } : { model, effort: effort.toLowerCase() }
}
