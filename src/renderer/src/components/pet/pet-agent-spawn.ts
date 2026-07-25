import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import {
  meshOmpCodingConfigPath,
  meshOmpMcpConfigDocPath,
  meshOmpSessionRoot
} from '@/lib/collab-canvas/mesh-omp-paths'
import { getPetBoundSession, setPetBoundSession } from './pet-bound-session'
import { resolveSpawnFreshness } from './pet-session-epoch'

/**
 * The pet's assistant arm.
 *
 * Hard-coded rather than read from settings because this is the mesh's standing
 * decision, recorded in plans/HANDOFF.md: LFM2.5-8B is the assistant default —
 * it ties gemma-4-12B on latency (12.7s vs 12.6s) but wins on context (128K) and
 * is already the voice arm, so speak-back and the pet answer from one model.
 * Never cloud, and never Ternary-Bonsai, which is 64–76s and depth-only.
 */
export const PET_OMP_MODEL = 'mesh-litellm/LFM2.5-8B-A1B-Q4_0.gguf'

/**
 * Session root / mesh config — ABSOLUTE paths (see mesh-omp-paths.ts).
 * Orca single-quotes every agentArgs token in the PTY startup command, so a
 * literal `$HOME/...` never expands and omp dies with
 * "Config overlay not found: <cwd>/$HOME/meshina/...".
 */
function petSessionRoot(): string {
  return meshOmpSessionRoot()
}

function petMeshConfig(): string {
  return meshOmpCodingConfigPath()
}

/** Doc path only (persona); MCP loads via ~/.omp/agent/mcp.json discovery. */
const PET_MCP_CONFIG_DOC = meshOmpMcpConfigDocPath()

/** MCP tool names the mesh's `mcp.json` exposes (Cloak → SearXNG priority).
 * Named in the persona only — never in omp `--tools`. omp 17.x validates
 * `--tools` against its native allowlist and rejects MCP names with
 * "Unknown tools in --tools". MCP loads via `~/.omp/agent/mcp.json`. */
const PET_MCP_TOOLS = 'cloakbrowser_browse,searxng_search'

/** Native omp tools only. MCP tools are NOT listed here (see PET_MCP_TOOLS). */
const PET_TOOLS = 'read,bash,edit,write,grep,glob,todo,web_search'

/** A short persona so the pet knows what it is and how to reach the mesh's web
 * tools, rather than sitting on a generic assistant prompt unaware of them.
 * Single-quoted as one shell token by tokenizeStartupCommand; keep it free of
 * single quotes and `$` so neither the tokenizer nor the owner-host shell mangle
 * it. */
const PET_PERSONA = [
  'You are the operator’s pet assistant inside Orca, bound to this workspace.',
  'You have read, bash, edit, write, grep, glob, todo, web_search,',
  'cloakbrowser_browse and searxng_search tools.',
  'Per HERMES web tool priority, prefer cloakbrowser_browse for any fetch,',
  'scrape or browse; fall back to searxng_search for SERP and quick lookups;',
  'reach for the built-in web_search only when both MCP tools are unavailable.',
  'The cloakbrowser_browse and searxng_search tools come from the mesh',
  `MCP config at ${PET_MCP_CONFIG_DOC}; if they are missing from your tool`,
  'set, the operator has not symlinked it at ~/.omp/agent/mcp.json yet,',
  'and you should say so rather than silently reach for the built-in web_search.',
  'Both MCP tools fail-closed (the call surfaces an error) if the mesh',
  'endpoint is down, so do not retry in a loop. Keep replies short and',
  'spoken-friendly — they are read aloud. Lead with the outcome.'
].join(' ')

/**
 * A stable, filesystem-safe session-dir name for a worktree's pet assistant.
 *
 * Keyed by worktree so the assistant spawned in repo A resumes repo A's thread,
 * not some global one. worktreeIds look like `repo::/abs/path`; anything that is
 * not `[A-Za-z0-9._-]` becomes `-` so the result is a single safe path segment,
 * and a short suffix keeps two worktrees that sanitize alike from colliding.
 */
export function petSessionDirName(worktreeId: string): string {
  const safe = worktreeId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
  let hash = 0
  for (let i = 0; i < worktreeId.length; i++) {
    hash = (hash * 31 + worktreeId.charCodeAt(i)) | 0
  }
  return `orca-pet-${safe}-${(hash >>> 0).toString(36)}`
}

/**
 * CLI arguments for a pet-spawned omp session.
 *
 * `--approval-mode always-ask` is deliberate and non-negotiable for a pet: it
 * can open ssh endpoints and browser panels, so it is a real actor and every
 * action should be confirmable. Surfacing those approvals on the bubble is the
 * next step; until then they surface in the pane itself, which is why this
 * spawns a visible pane rather than a headless session.
 *
 * `--session-dir <per-worktree> --continue` is what makes the assistant
 * durable. `--continue` resumes the most recent session in that dir — probed
 * 2026-07-21: across separate processes it appends to the one session file and
 * turn N sees turns 1..N-1, and on an empty dir it simply starts fresh (exit 0,
 * no error). So the pet's assistant survives a tab close or an app restart:
 * re-spawning into the same dir picks the thread back up. We use `--continue`
 * rather than `--resume <id>` precisely to avoid discovering the session uuid
 * from the renderer, which cannot read the owner host's filesystem.
 *
 * Still a pane, not `--mode rpc`: pane-hosting is what earns free agent status
 * via the ORCA_PANE_KEY-gated extension, which a session we drove ourselves
 * could never satisfy.
 *
 * `fresh` drops `--continue` so omp starts a NEW session in the same dir instead
 * of resuming the latest — the rotation the operator asked for, so context does
 * not accrete indefinitely on a small local model. The dir is unchanged, so a
 * later resume still finds this fresh thread as the most recent.
 */
export function buildPetOmpAgentArgs(
  worktreeId: string,
  options: { fresh?: boolean; model?: string } = {}
): string {
  const model = options.model ?? PET_OMP_MODEL
  const sessionDir = `${petSessionRoot()}/${petSessionDirName(worktreeId)}`
  const parts = [
    '--approval-mode always-ask',
    `--model ${model}`,
    `--config ${petMeshConfig()}`,
    `--tools ${PET_TOOLS}`,
    `--session-dir ${sessionDir}`,
    // Fresh spawns omit --continue so omp starts a new session in the same dir.
    ...(options.fresh ? [] : ['--continue']),
    `--append-system-prompt '${PET_PERSONA}'`
  ]
  return parts.join(' ')
}

/**
 * Right-click → spawn the pet an assistant.
 *
 * Routed through `launchAgentInNewTab` rather than a hand-built terminal
 * command: that path already resolves the launch platform for SSH/WSL/remote
 * repos, records agent telemetry, and registers the tab's `launchAgent` so the
 * new pane is recognized as an agent session rather than a bare shell.
 *
 * Returns a null spawn when there is no active worktree — an agent has to be
 * launched *somewhere*, and silently picking a repo the user is not looking at
 * would be worse than not offering the row.
 */
export function usePetAgentSpawn(): {
  canSpawn: boolean
  spawnOmpAgent: () => void
} {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)

  const spawnOmpAgent = useCallback((): void => {
    if (!activeWorktreeId) {
      return
    }
    // Why capture here rather than render the binding into the closure: a stale
    // closure over `previousBoundTabId` would freeze whatever binding existed
    // when the hook ran, and the rebind we trigger below updates the binding
    // — sampling at click time matches the rebind.
    const previousBoundTabId = getPetBoundSession()?.tabId ?? null
    try {
      // Rotate to a clean session on the 1–3h cadence; otherwise resume.
      const fresh = resolveSpawnFreshness(petSessionDirName(activeWorktreeId))
      // Why quickCommandLabel: tab title must read as pet assistant, not another
      // anonymous "Terminal N" / omp coding session mixed into project work.
      // Still launched in the active worktree so cwd + session-dir stay project-
      // bound (tools see the repo); the label + launchSource are the distinction.
      const result = launchAgentInNewTab({
        agent: 'omp',
        worktreeId: activeWorktreeId,
        agentArgs: buildPetOmpAgentArgs(activeWorktreeId, { fresh }),
        launchSource: 'pet',
        quickCommandLabel: 'Pet assistant'
      })
      // Why bind here and not from agent status: an omp pane reports `agents:
      // []` until its first prompt, so a pet that waited for status would spawn
      // an assistant and then still have nothing to say to it. Binding the tab
      // we just created is what makes the pet askable immediately.
      if (result?.tabId) {
        // Why: rotation (or any rebind) swaps the pet onto a fresh omp tab
        // while the previous tab's PTY stays alive — omp keeps posting status
        // on its paneKey, so without this sweep the previous tab's row stays
        // fresh and the pet stays permanently busy. Drop the prior bound
        // tab's agent-status entries on every successful rebind (the pet now
        // points at a different tab, so the orphaned row is no longer
        // relevant) and mirror the closed-tab suppression so a late hook
        // event from the dying session cannot resurrect it under us.
        if (previousBoundTabId && previousBoundTabId !== result.tabId) {
          useAppStore.getState().dropAgentStatusByTabPrefix(previousBoundTabId)
        }
        setPetBoundSession({ tabId: result.tabId, worktreeId: activeWorktreeId })
      }
    } catch (error) {
      // Why surface rather than swallow: the pet is a 48px sprite with no
      // status line of its own, so a failed spawn would otherwise look exactly
      // like a click that did nothing — the same failure mode that made the
      // no-target menu look broken.
      toast.error(String(error instanceof Error ? error.message : error))
    }
  }, [activeWorktreeId])

  return { canSpawn: Boolean(activeWorktreeId), spawnOmpAgent }
}
