import type { BundledSkillLeaveReason, BundledSkillOp } from './bundled-skill-plan'
import { isBundledSkillLeaveReason } from './bundled-skill-plan'
import { SKILL_INSTALL_PROVIDERS } from './skill-install-providers'

/** What Update does, or did nothing, at one location. */
export type BundledSkillLocationState =
  | 'update'
  | 'repair'
  | 'install'
  | 'link'
  | 'replace'
  | 'keep'
  | 'keep-link'
  | 'leave'
  | 'unknown'

export type BundledSkillLocation = {
  path: string
  /** `path` with the planned host's home shown as `~`. */
  displayPath: string
  /** `shared` is the `.agents/skills` folder; otherwise the agents that read this folder. */
  place: { kind: 'shared' } | { kind: 'agents'; names: string[] }
  state: BundledSkillLocationState
  reason: BundledSkillLeaveReason | null
  /** Whether Replace / `--force` may back it up and put Orca's copy in its place. */
  replaceable: boolean
}

const OP_STATE: Readonly<Record<string, BundledSkillLocationState>> = {
  update: 'update',
  restore: 'repair',
  write: 'install',
  copy: 'install',
  link: 'link',
  replace: 'replace',
  leave: 'leave'
}

/** Windows homes compare case-insensitively and may use either separator. */
export function collapseHomePath(path: string, homeDirectory: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/iu.test(homeDirectory)
  const fold = (value: string) => (windows ? value.replace(/\//gu, '\\').toLowerCase() : value)
  const home = homeDirectory.replace(/[\\/]+$/u, '')
  const head = fold(path.slice(0, home.length))
  const separator = path.charAt(home.length)
  if (home && head === fold(home) && (separator === '/' || separator === '\\')) {
    return `~${path.slice(home.length)}`
  }
  return path
}

function agentNames(agents: readonly string[]): string[] {
  return agents.flatMap((agent) => {
    const name = SKILL_INSTALL_PROVIDERS.find((provider) => provider.id === agent)?.displayName
    return name ? [name] : []
  })
}

export function bundledSkillLocation(
  op: BundledSkillOp,
  homeDirectory: string
): BundledSkillLocation {
  const state =
    op.kind === 'keep'
      ? op.observed.kind === 'link'
        ? 'keep-link'
        : 'keep'
      : (OP_STATE[op.kind] ?? 'unknown')
  return {
    path: op.path,
    displayPath: collapseHomePath(op.path, homeDirectory),
    place:
      op.role === 'shared' ? { kind: 'shared' } : { kind: 'agents', names: agentNames(op.agents) },
    state,
    reason: op.reason && isBundledSkillLeaveReason(op.reason) ? op.reason : null,
    replaceable: (op.kind === 'leave' && op.replaceable === true) || op.kind === 'replace'
  }
}
