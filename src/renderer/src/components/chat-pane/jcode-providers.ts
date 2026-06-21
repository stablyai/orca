// Why: the composer's Claude-style model/provider chip needs a list to pick
// from. We use a small curated static set that mirrors `jcode provider list`
// rather than shelling out per render (which would add an IPC surface + latency
// for a rarely-changing list). "Auto" is represented by an undefined provider
// in the chat-session-store, which falls back to ChatPane's default provider.

export type JcodeProviderOption = {
  /** jcode provider id passed as -p. */
  id: string
  /** Human label shown in the chip dropdown. */
  label: string
  /** Optional suggested model ids (passed as -m). First is the default chip. */
  models?: string[]
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
