import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat-session-option-state'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const CODEX_EFFORT_IDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function normalizedScreenLines(screen: string): string[] {
  return stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
}

function statusItemHead(line: string): string {
  return (
    line
      .replace(/^[^A-Za-z0-9]+/, '')
      .split(' · ')[0]
      ?.trim() ?? ''
  )
}

function catalogForModels(
  models: readonly CatalogModel[] | undefined
): NonNullable<ReturnType<typeof getAgentSessionOptionCatalog>> | null {
  const catalog = getAgentSessionOptionCatalog('codex')
  if (!catalog) {
    return null
  }
  return models ? { ...catalog, models: [...models] } : catalog
}

function matchCatalogModelId(
  catalog: NonNullable<ReturnType<typeof getAgentSessionOptionCatalog>>,
  candidate: string
): string | null {
  const seeded = getAgentSessionOptionCatalog('codex')
  return (
    matchNativeChatCatalogModelId(catalog, candidate) ??
    (seeded ? matchNativeChatCatalogModelId(seeded, candidate) : null)
  )
}

function matchLeadingCodexModel(
  head: string,
  catalog: NonNullable<ReturnType<typeof getAgentSessionOptionCatalog>>
): { modelId: string; rest: string } | null {
  const tokens = head.split(' ').filter(Boolean)
  const first = tokens[0]
  if (!first) {
    return null
  }
  const second = tokens[1]
  // Labels are two tokens (`GPT-5.6 Luna`); the effort token must not be
  // folded into a containment match of `{slug} max`.
  if (second && !CODEX_EFFORT_IDS.has(second.toLowerCase())) {
    const labeled = matchCatalogModelId(catalog, `${first} ${second}`)
    if (labeled) {
      return { modelId: labeled, rest: tokens.slice(2).join(' ') }
    }
  }
  const modelId = matchCatalogModelId(catalog, first)
  return modelId ? { modelId, rest: tokens.slice(1).join(' ') } : null
}

/**
 * Codex prints `model-with-reasoning` as `{slug} {effort}[ {tier}]`, then joins
 * later status items with ` · `. Search from the bottom so conversation text
 * that happens to name a model cannot win over the live status line.
 */
export function readCodexSessionOptionsFromTerminalScreen(
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const catalog = catalogForModels(models)
  if (!catalog) {
    return null
  }
  const lines = normalizedScreenLines(screen)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const head = statusItemHead(lines[index] ?? '')
    const matched = matchLeadingCodexModel(head, catalog)
    if (!matched) {
      continue
    }
    const result: Record<string, SessionOptionValue> = { model: matched.modelId }
    const effort = matched.rest.split(' ')[0]?.toLowerCase()
    if (effort && CODEX_EFFORT_IDS.has(effort)) {
      result.effort = effort
    }
    return result
  }
  return null
}
