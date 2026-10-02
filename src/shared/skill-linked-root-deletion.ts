import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentSkillHomeRoots,
  buildAgentSkillRepoRoots,
  CANONICAL_AGENT_SKILLS_ROOT_ID,
  type AgentSkillScanRoot
} from './agent-skill-scan-roots'
import {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots
} from './agent-skill-provider-root-overrides'
import { isDefinitiveAbsence } from './definitive-filesystem-absence'

/**
 * Destinations `npx skills update` would delete because their agent skills root is a link.
 *
 * Upstream's `createSymlink` (vercel-labs/skills `src/installer.ts`) does two things to a
 * real directory standing where it wants its link: `rm(linkPath, { recursive: true })`, then
 * a replacement whose relative target is measured from the *unresolved* root —
 * `resolveParentSymlinks` realpaths only `dirname(root)` and re-joins the basename. With a
 * linked root that replacement dangles, so the user's directory is gone and nothing usable
 * takes its place. That is orca#22897 (upstream #456/#481 cover the dangling half; #2283
 * fixes only the measurement and is still open). Reproduced on every published version from
 * 1.0.18 through 1.7.0, so there is no fixed version to pin Orca's spawn to.
 *
 * Both halves need the same narrow conjunction, and that conjunction is all this reports:
 * the root is a link AND the per-skill destination is a real directory. Symlinks here are
 * legitimate — Orca places its own relative link (Windows junction) at
 * `<root>/<name>` (docs/reference/agent-skill-provider-paths.md), and #22897's reporter
 * links `~/.claude/skills` at their dotfiles on purpose. Neither is reported: a link Orca
 * placed is not a real directory, and a root that is a real directory is not a link.
 */

/** Extends the `skill-placement-unowned` vocabulary to the linked-root case. */
export const SKILL_LINKED_ROOT_DELETION_CODE = 'skill-placement-unowned-in-linked-root'

export type SkillLinkedRootDeletion = {
  name: string
  /** The agent skills root that is a link, e.g. `~/.claude/skills`. */
  rootPath: string
  rootLabel: string
  /** The real directory inside it that `skills update` would remove. */
  destinationPath: string
  errorCategory: string
}

/**
 * The canonical `.agents/skills` root holds the content every provider link points at, so
 * `createSymlink` never runs against it — linking it would be linking a path to itself.
 * Excluded on purpose: a user who keeps their canonical copy in linked dotfiles has real
 * directories there by design, and blocking them would be the broad guard this is not.
 */
function isCanonicalAgentSkillsRoot(root: AgentSkillScanRoot): boolean {
  return root.id === CANONICAL_AGENT_SKILLS_ROOT_ID || root.id.startsWith('repo-agents-')
}

/**
 * Whether a root's own `lstat` cleared it, condemned it, or answered nothing at all.
 *
 * `undetermined` is a real outcome, not a tidy-up: `lstat` on a WSL ext4 symlink reached over
 * the 9P redirector (`\\wsl.localhost\<distro>\...`) throws **EISDIR**, and a `catch` that
 * returns "not a link" turns that into a clean bill of health for a root that is linked.
 * `isDefinitiveAbsence` is the repo's one errno allowlist for "really not there".
 */
type AgentSkillsRootShape = 'link' | 'directory' | 'absent' | 'undetermined'

/**
 * Windows junctions report BOTH `isSymbolicLink()` and `isDirectory()`, so link-ness is
 * always asked first (precedent: `src/main/pty/overlay-mirror.ts`, issue #1083).
 */
async function classifyRoot(path: string): Promise<AgentSkillsRootShape> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'link' : 'directory'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'absent' : 'undetermined'
  }
}

/**
 * A directory in its own right — not a link to one, which upstream replaces harmlessly.
 *
 * The asymmetry with `classifyRoot` is deliberate. An unreadable *root* widens the search;
 * an unreadable *destination* narrows it, because only a positive answer here can cost a
 * user their update. So no unknown errno ever invents a skip on its own.
 */
async function isRealDirectory(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null)
  return entry ? !entry.isSymbolicLink() && entry.isDirectory() : false
}

/**
 * Only `lstat` booleans decide this, never a path comparison, so the win32-only
 * case folding in `skill-placement-reconciliation.ts` (which makes case-differing
 * paths compare unequal on case-insensitive APFS) is nowhere in the answer.
 */
export async function findSkillLinkedRootDeletions(input: {
  names: readonly string[]
  /** `skills update --global` writes the home roots; `--project` writes the cwd's. */
  scope?: 'global' | 'project'
  homeDir?: string
  cwd?: string
  /** Overridden in tests; both entry points read this host's own env by default. */
  env?: NodeJS.ProcessEnv
  roots?: readonly AgentSkillScanRoot[]
}): Promise<SkillLinkedRootDeletion[]> {
  const names = [...new Set(input.names)]
  if (names.length === 0) {
    return []
  }
  const home = input.homeDir ?? homedir()
  const env = input.env ?? process.env
  // Why the env here: `CLAUDE_CONFIG_DIR`, `GROK_HOME` and `HERMES_HOME` move the very
  // root this judges, so reading the default path instead would judge a folder the CLI
  // never writes to — and clear a skill that is still at risk.
  const candidateRoots =
    input.roots ??
    ((input.scope ?? 'global') === 'global'
      ? buildAgentSkillHomeRoots({
          home,
          hermesSkillsRoot:
            resolveEnvironmentHermesSkillsRoot(env) ??
            resolveDefaultHermesSkillsRoot({ homeDir: home, env }),
          providerRootOverrides: resolveEnvironmentSkillProviderRoots(env)
        }).filter((root) => root.sourceKind === 'home')
      : buildAgentSkillRepoRoots(input.cwd ?? process.cwd()))
  const found: SkillLinkedRootDeletion[] = []
  for (const root of candidateRoots) {
    if (isCanonicalAgentSkillsRoot(root)) {
      continue
    }
    // Why `undetermined` is judged rather than waved through: on its own it reports nothing,
    // because a name is only reported when `isRealDirectory` *succeeds* and says real
    // directory. So the cost is bounded to roots where the at-risk shape is positively
    // confirmed, while clearing them would keep answering "update" for every linked
    // \\wsl.localhost root — the wrong answer, and one no read can later correct.
    const shape = await classifyRoot(root.path)
    if (shape === 'directory' || shape === 'absent') {
      continue
    }
    for (const name of names) {
      const destinationPath = join(root.path, name)
      if (await isRealDirectory(destinationPath)) {
        found.push({
          name,
          rootPath: root.path,
          rootLabel: root.label,
          destinationPath,
          errorCategory: SKILL_LINKED_ROOT_DELETION_CODE
        })
      }
    }
  }
  return found
}

/** One actionable sentence per skipped skill, for the surfaces that show plain text. */
export function describeSkillLinkedRootDeletion(deletion: SkillLinkedRootDeletion): string {
  return (
    `Skipped ${deletion.name}: ${deletion.rootPath} is a link, and ${deletion.destinationPath} ` +
    'is a real directory inside it. The skills CLI deletes a real directory before writing ' +
    'its own shortcut there, and a shortcut written into a linked root does not resolve, so ' +
    'that directory would be lost. Replace it with a shortcut to your shared .agents/skills ' +
    'copy, or move it out of this folder, to let Orca update this skill again.'
  )
}
