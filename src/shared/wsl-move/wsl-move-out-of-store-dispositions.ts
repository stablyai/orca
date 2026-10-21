import type { WslMoveFieldDisposition } from './wsl-move-dispositions'

/** State outside the main store, covered by row only (no schema to census). */
export const OUT_OF_STORE_DISPOSITIONS: readonly (WslMoveFieldDisposition & {
  store: string
})[] = [
  {
    store: 'terminal-history/<session>/ (daemon checkpoint, output.log)',
    disposition: 'not-applicable',
    item: 48,
    note: 'Read at quiesce for the last cwd and as a scrollback fallback, then retained.'
  },
  {
    store: 'per-pane last cwd',
    disposition: 'move',
    item: 49,
    newManifestSection: true,
    note: 'dormantState.terminalRestoreHints.'
  },
  {
    store: 'terminal-history-wsl/<distro>/<hash(worktreeId)>/ (shell history)',
    disposition: 'move',
    item: 50,
    newManifestSection: true,
    note: 'Blob; re-keyed by the Linux worktree id on the host.'
  },
  { store: 'agent-hooks/last-status.json', disposition: 'rederive', item: 51 },
  {
    store: 'agent-session-journal.db',
    disposition: 'not-applicable',
    item: 52,
    note: 'Chats stay local on the desktop (owner decision C); the journal is not moved.'
  },
  { store: 'orchestration.db', disposition: 'rewrite-desktop', item: 53 },
  {
    store: 'codex-pane-accounts.json',
    disposition: 'not-applicable',
    item: 54
  },
  {
    store: 'agent trust entries (.claude.json, config.toml, ...)',
    disposition: 'rederive',
    item: 55,
    note: 'Written on the host that runs the agent; the Claude writer already stores the Linux form.'
  },
  {
    store: 'agent transcripts in the distro',
    disposition: 'not-applicable',
    item: 56
  },
  { store: 'AI Vault filters', disposition: 'rederive', item: 57 },
  {
    store: 'browser partition (cookies, site storage)',
    disposition: 'rewrite-desktop',
    item: 58,
    note: "The WSL host's route partition binds to the local profile partition (decision 3)."
  },
  {
    store: 'notifications, push, dismissals',
    disposition: 'not-applicable',
    item: 59
  },
  { store: 'port forwards', disposition: 'not-applicable', item: 60 },
  { store: '.orca/ and repo files', disposition: 'not-applicable', item: 61 },
  {
    store: 'renderer live maps (expandedDirs, git status)',
    disposition: 'rederive',
    item: 46
  },
  {
    store: 'hook settings (setup/archive scripts)',
    disposition: 'move',
    item: 2,
    note: 'Inside repos[]; scripts already run in the distro.'
  },
  {
    store: 'diff comments inside worktreeMeta',
    disposition: 'move',
    item: 12
  },
  {
    store: 'linked issues/PRs inside worktreeMeta',
    disposition: 'move',
    item: 13
  },
  {
    store: 'worktreeMeta.priorWorktreeIds',
    disposition: 'move',
    item: 14,
    note: 'Append the UNC id so stragglers still resolve.'
  },
  {
    store: 'renderer native chat composer drafts (IndexedDB)',
    disposition: 'not-applicable',
    item: 45
  },
  {
    store: 'settings floating terminal cwd',
    disposition: 'not-applicable',
    item: 41
  },
  {
    store: 'session buffers / scrollback snapshots',
    disposition: 'move',
    item: 24
  }
]
