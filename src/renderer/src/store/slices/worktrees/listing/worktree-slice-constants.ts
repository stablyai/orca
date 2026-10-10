// Why: old runtime servers only have `worktree.list`; preserve the large-list UI hydration parity used before `worktree.detectedList` existed.
export const REMOTE_WORKTREE_LIST_PARITY_LIMIT = 10_000
export const WORKTREE_REMOVAL_AMBIGUOUS_ERROR =
  'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
// Why (STA-4343): the confirmed row names the host to delete on. If the route
// no longer lands there, deleting anyway destroys another host's workspace.
export const WORKTREE_REMOVAL_HOST_CHANGED_ERROR =
  'This workspace is no longer on the host you confirmed. Refresh and review it again.'
export const ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS = 300
export const ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS = 450
export const ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS = 180
export const FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS = 1_000
// Why: each repo's `git worktree list` is an independent main-process child; a higher ceiling cuts startup scan batches (#7225) while staying bounded against launching every git probe at once.
export const WORKTREE_REFRESH_CONCURRENCY = 8
// Why: a mobile-scope web pairing is denied worktree/repo RPCs (else silently empty workspaces); surface one deduped toast (stable id) instead of spamming per-repo.
export const RUNTIME_SCOPE_FORBIDDEN_TOAST_ID = 'runtime-scope-forbidden'
// Why: main retires the persisted SSH metadata a scan proved gone, but that IPC is async and the next fallback
// read can already be in flight, so this session memory covers the window until the delete lands. It is not the
// durable half: reloads start empty and rely on the metadata itself being gone.
export const AUTHORITATIVE_REMOVAL_MEMORY_LIMIT = 512
