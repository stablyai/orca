/**
 * Kiro CLI ships two agent engines side by side: the pre-3.0 `v2` harness and
 * the `v3` KAS ("Kiro Agent Server") agent that becomes the default in 3.0.
 *
 * They are not interchangeable for automation. Under v2 `/usage` is a real
 * slash command that prints the plan meter locally; under v3 it is ordinary
 * prompt text the model answers in prose — which costs credits and returns no
 * meter. So anything Orca drives through `kiro-cli chat` names the engine it
 * needs instead of inheriting whatever the installed CLI defaults to.
 */
export type KiroAgentEngine = 'v1' | 'v2' | 'v3'

export const KIRO_AGENT_ENGINES = ['v1', 'v2', 'v3'] as const satisfies readonly KiroAgentEngine[]

/** The only engine whose `/usage` slash command prints the plan meter. */
export const KIRO_USAGE_ENGINE: KiroAgentEngine = 'v2'

/** `kiro-cli chat --agent-engine <engine> …` — the flag follows the subcommand. */
export function kiroAgentEngineArgs(engine: KiroAgentEngine): string[] {
  return ['--agent-engine', engine]
}

const UNSUPPORTED_FLAG_PHRASES = [
  'unexpected argument',
  'unrecognized argument',
  'unknown argument',
  'unknown option',
  'unexpected option'
]

/**
 * True when the CLI rejected `--agent-engine` as an argument it does not know.
 *
 * Kiro's clap parser exits 2 with `error: unexpected argument '--agent-engine'
 * found`. A build that old predates v3 entirely, so the caller drops the flag
 * and keeps the CLI's own default rather than failing the read. Deliberately
 * narrow: it must name the flag, so an unrelated argument error still surfaces.
 */
export function isKiroUnsupportedEngineFlagOutput(text: string): boolean {
  if (!text.includes('--agent-engine')) {
    return false
  }
  const lowered = text.toLowerCase()
  return UNSUPPORTED_FLAG_PHRASES.some((phrase) => lowered.includes(phrase))
}

// The v3 engine announces itself on startup as
// `[INFO] kas.server.starting {"product":"KAS (Kiro Agent Server)",…}`.
const V3_ENGINE_MARKERS = ['kas.server.starting', 'kiro agent server']

/**
 * True when v3 served the run. On a `/usage` read that means the engine pin did
 * not take and the prompt reached the model, so the answer is prose and every
 * retry bills again — the caller must give up rather than spend two more turns.
 */
export function isKiroV3EngineOutput(text: string): boolean {
  const lowered = text.toLowerCase()
  return V3_ENGINE_MARKERS.some((marker) => lowered.includes(marker))
}
