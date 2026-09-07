import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolvePaneAgentIdentity } from './pane-agent-identity-resolver'
import type { TuiAgent } from './tui-agent'

/**
 * The agent a host publishes for a pane, for consumers that ACT on identity.
 *
 * Kept out of the runtime class so it can be tested without one, and so routing, delivery and the
 * UI all read the same decision instead of each re-deriving it.
 *
 * Hook evidence ranks first because the agent reports its own identity regardless of how it was
 * started — Orca's launcher, a shell prompt, or a resumed session — and regardless of host.
 *
 * Title ranks LAST and is a genuine last resort, not forbidden. An earlier revision refused it
 * outright for action consumers, reasoning that a title must never authorize a write. That
 * conflated the parser with the raw substring match it replaced: `collectAgentTitleEvidence`
 * returns null on exactly the shapes that caused misdelivery — "Review the Claude session-history
 * fix" on a Codex pane yields nothing, and "Switch Claude and Codex off the load balancer… - grok"
 * yields grok from its owner suffix. Refusing it instead cost real panes their identity: an agent
 * a user started by hand inside an Orca WSL terminal has no launch record, no readable foreground
 * process (the Windows host sees `wsl.exe`), and — until managed Codex hooks install there — no
 * hook either, leaving a title that names it unambiguously as the only thing left.
 *
 * Returns undefined when nothing is known, and absence is published as absence. A caller that
 * authorizes an action must fail closed on it rather than falling back to parsing the title.
 */
export function resolvePublishedPaneAgentIdentity(args: {
  /**
   * The agent a provider hook reported for this pane. The ONLY signal that does not depend on how
   * the agent was started: a user who types `claude` at a shell still posts hooks. It is also the
   * only one that survives WSL, where the Windows host reads the foreground process as `wsl.exe`
   * rather than the agent running inside the distro.
   */
  hookAgent?: TuiAgent | null
  /** Whether that hook belongs to a turn in progress, as opposed to one that finished. */
  hookIsLive?: boolean
  launchAgent?: TuiAgent | null
  foregroundAgent?: TuiAgent | null
  title?: string | null
}): TuiAgent | undefined {
  const titleAgent = args.title ? collectAgentTitleEvidence(args.title).agent : null
  return (
    resolvePaneAgentIdentity({
      evidence: [
        ...(args.hookAgent
          ? [
              {
                source: args.hookIsLive ? ('live-hook' as const) : ('completed-hook' as const),
                agent: args.hookAgent
              }
            ]
          : []),
        ...(args.foregroundAgent
          ? [{ source: 'process' as const, agent: args.foregroundAgent }]
          : []),
        ...(args.launchAgent ? [{ source: 'launch' as const, agent: args.launchAgent }] : []),
        ...(titleAgent ? [{ source: 'title' as const, agent: titleAgent }] : [])
      ]
    }).agent ?? undefined
  )
}
