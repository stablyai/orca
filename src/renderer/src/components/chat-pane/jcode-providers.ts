// Why: the composer's Claude-style model/provider chip needs a list to pick
// from. We use a small curated static set that mirrors `jcode provider list`
// rather than shelling out per render (which would add an IPC surface + latency
// for a rarely-changing list). "Auto" is represented by an undefined provider
// in the chat-session-store, which falls back to ChatPane's default provider.

import { useEffect, useState } from 'react'
import type { JcodeCustomProvider, JcodeModelCatalog } from '../../../../shared/jcode-chat-types'

export type JcodeProviderOption = {
  /** jcode provider id passed as -p. */
  id: string
  /** Human label shown in the chip dropdown. */
  label: string
  /** Optional suggested model ids (passed as -m). First is the default chip. */
  models?: string[]
  /** Discriminates a built-in `-p provider` from a custom `--provider-profile`.
   *  Defaults to 'builtin' for the static list below. */
  kind?: 'builtin' | 'profile'
}

/** Curated subset of `jcode provider list`, covering the common cases the brief
 *  asks for plus a few high-traffic ones. Not exhaustive on purpose. */
export const JCODE_PROVIDERS: JcodeProviderOption[] = [
  { id: 'jcode', label: 'Jcode Subscription' },
  { id: 'claude', label: 'Claude', models: ['claude-opus-4-8', 'claude-sonnet-4-5'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-5.5', 'gpt-5-mini'] },
  { id: 'gemini', label: 'Gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai-compatible', label: 'OpenAI-compatible' }
]

export function findProviderOption(id: string | undefined): JcodeProviderOption | undefined {
  if (!id) {
    return undefined
  }
  return JCODE_PROVIDERS.find((entry) => entry.id === id)
}

/** Map the user's persisted custom provider profiles into chip options. A
 *  selected option here carries `kind: 'profile'`, so the composer routes the
 *  selection to the chat payload's `providerProfile` (which the main process
 *  emits as `--provider-profile <name>`) rather than `-p provider`. */
export function buildProfileOptions(
  profiles: JcodeCustomProvider[] | undefined
): JcodeProviderOption[] {
  if (!profiles || profiles.length === 0) {
    return []
  }
  return profiles.map((profile) => ({
    id: profile.name,
    label: profile.name,
    models: profile.model ? [profile.model] : undefined,
    kind: 'profile'
  }))
}

/** Resolve a custom profile option by name, or undefined. */
export function findProfileOption(
  profiles: JcodeCustomProvider[] | undefined,
  name: string | undefined
): JcodeProviderOption | undefined {
  if (!name) {
    return undefined
  }
  return buildProfileOptions(profiles).find((entry) => entry.id === name)
}

// ─── Real model catalog (jcode model list --json) ───────────────────────────
// The detailed picker (Claude/Codex-app style) is driven by the REAL catalog
// instead of the static JCODE_PROVIDERS model hints above. We map each route's
// provider DISPLAY name back to the `-p` provider id so selecting a model also
// pins the right provider/auth source.

const ROUTE_PROVIDER_TO_ID: Record<string, string> = {
  openai: 'openai',
  anthropic: 'claude',
  'anthropic/claude': 'claude',
  claude: 'claude',
  google: 'gemini',
  gemini: 'gemini',
  'jcode subscription': 'jcode',
  jcode: 'jcode',
  openrouter: 'openrouter',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  perplexity: 'perplexity'
}

/** Map a `jcode model list` route provider display name to its `-p` id. */
export function routeProviderToId(display: string): string {
  const key = display.trim().toLowerCase()
  return ROUTE_PROVIDER_TO_ID[key] ?? key.replace(/[^a-z0-9]+/g, '-')
}

export type JcodeModelGroup = {
  /** Provider display name as jcode reports it, e.g. "OpenAI". */
  providerDisplay: string
  /** Mapped `-p` provider id, e.g. "openai". */
  providerId: string
  models: { id: string; available: boolean; method?: string }[]
}

/** Group a catalog's routes by provider, with authed providers first. */
export function groupCatalogRoutes(catalog: JcodeModelCatalog | null): JcodeModelGroup[] {
  if (!catalog?.routes?.length) {
    return []
  }
  const byProvider = new Map<string, JcodeModelGroup>()
  for (const route of catalog.routes) {
    let group = byProvider.get(route.provider)
    if (!group) {
      group = {
        providerDisplay: route.provider,
        providerId: routeProviderToId(route.provider),
        models: []
      }
      byProvider.set(route.provider, group)
    }
    group.models.push({ id: route.model, available: route.available, method: route.method })
  }
  return [...byProvider.values()].sort((a, b) => {
    const aRank = a.models.some((m) => m.available) ? 0 : 1
    const bRank = b.models.some((m) => m.available) ? 0 : 1
    return aRank - bRank || a.providerDisplay.localeCompare(b.providerDisplay)
  })
}

// Module-level cache so the catalog is fetched once per app run (not per chip
// open). `refresh` forces a re-fetch (e.g. after the user logs into a provider).
let catalogPromise: Promise<JcodeModelCatalog> | null = null

export function fetchModelCatalog(force = false): Promise<JcodeModelCatalog> {
  if (force || !catalogPromise) {
    catalogPromise = window.api.jcodeProviders.listModels().catch(
      (error: unknown): JcodeModelCatalog => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        models: [],
        routes: []
      })
    )
  }
  return catalogPromise
}

/** React hook: load the real model catalog (cached). `refresh()` re-fetches. */
export function useJcodeModelCatalog(): {
  catalog: JcodeModelCatalog | null
  loading: boolean
  refresh: () => void
} {
  const [catalog, setCatalog] = useState<JcodeModelCatalog | null>(null)
  const [loading, setLoading] = useState(true)

  const load = (force: boolean): void => {
    setLoading(true)
    fetchModelCatalog(force)
      .then((next) => {
        setCatalog(next)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { catalog, loading, refresh: () => load(true) }
}
