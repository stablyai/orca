import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolvePaneAgentIdentity } from './pane-agent-identity-resolver'
import type { TerminalAgent } from './terminal-agent'
import type { TuiAgent } from './tui-agent'

/** Publish one host identity decision for routing/delivery/UI. Live hooks identify launcher-, shell- and resume-started agents.
 * Strict parsed titles remain the final fallback for hand-started WSL panes lacking launch/process/hooks (Windows sees wsl.exe);
 * reject task-prose names instead of raw substring matching. Publish undefined when unknown; action consumers must fail closed
 * rather than parse their own fallback titles. */
export function resolvePublishedPaneAgentIdentity(args: {
  /** Provider hooks identify shell-started agents too, including WSL where Windows foreground reads only wsl.exe. */
  hookAgent?: TerminalAgent | null
  /** Whether that hook belongs to a turn in progress, as opposed to one that finished. */
  hookIsLive?: boolean
  launchAgent?: TuiAgent | null
  foregroundAgent?: TerminalAgent | null
  title?: string | null
}): TerminalAgent | undefined {
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
