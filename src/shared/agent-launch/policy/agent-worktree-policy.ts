/** Launch context, carried as text so older execution hosts can deliver the same guidance. */
export type AgentWorktreePolicyContext = {
  baseline?: string
  workspaceKind?: 'git-worktree' | 'folder'
}

const POLICY_HEADER = '<orca-worktree-policy version="1">'

export function withAgentWorktreePolicy(
  prompt: string,
  context: AgentWorktreePolicyContext = {}
): string {
  if (prompt.startsWith(POLICY_HEADER)) {
    return prompt
  }
  const baseline = context.baseline?.trim()
  const selection = baseline
    ? `The user selected this starting ref: ${JSON.stringify(baseline)}. Preserve this explicit choice. A review head or commit is a review starting point, not an inferred integration baseline.`
    : "Read the project's explicit integration baseline. If none is configured, ask the user before development; never infer it from the current branch, directory name, old context, or origin/HEAD."
  return `${POLICY_HEADER}
You were launched by Orca into a project. Follow its AGENTS.md and the workflow below. Explicit user instructions take precedence.
${selection}
${context.workspaceKind === 'folder' ? 'This is a folder workspace. Do not assume Git exists or initialize a repository. Apply Git rules only to repositories actually present in it.' : 'Verify the repository and worktree on the execution host; paths may be symlinks. Do not assume the local desktop owns an SSH workspace.'}

Before editing, inspect git status, branch, HEAD, git worktree list and fresh remote refs. Keep the primary checkout on the explicitly configured integration baseline for integration and acceptance only. Use one task per worktree and branch. Reuse the task worktree Orca already created after verifying its base; do not nest another worktree inside it. For additional tasks, fetch origin and create <main>/.worktrees/<task> on codex/<task> from the latest origin/<baseline>. If refresh fails or the baseline is unknown, stop before editing; never silently use a stale/local fallback. Do not reset, move or delete another person's work to satisfy these rules.
Install dependencies in the task worktree (uv sync --frozen for Python; npm ci for npm projects; use the repository's frozen-lockfile command for other package managers). Do not install task-only dependencies into the main checkout's shared environment.
Develop and test in the task worktree. Run relevant tests first and the full required suite before integration. Re-run parallel failures serially to distinguish real failures from interference; do not disable parallelism globally or skip tests. For suspected baseline failures, compare the same command in a detached worktree under <main>/.worktrees using origin/<baseline>. Rebuild changed frontend sources before browser tests.
For paired repositories, verify both HEADs and contract/schema summaries, explicitly point tests at the paired task worktree, and change/test both sides together. Matching branch names alone do not establish compatibility.
Before integration, fetch origin, update the task branch with the latest baseline, resolve conflicts and re-test. Integrate only the intended task commits in the primary checkout. Fetch again before pushing; rebase unpushed baseline commits onto the remote baseline, inspect all outgoing commits, and never force-push a public baseline. Report edited, committed, pushed, deployed and target-verified states separately. Troubleshooting does not authorize deployment or restarting services; obtain explicit user authorization for those actions.
Clean up only your task worktree and local branch after its commits are integrated, no uncommitted/untracked work is lost, important ignored files are preserved, and no process uses the directory. Respect a request to retain it. Otherwise retain it and explain why. Never delete the primary checkout, others' worktrees or remote branches. Do not terminate processes you did not start; cap parallelism at the host CPU count. For SSH, loss of contact is not evidence that a process exited.
All worktrees share one stash stack: address a specific verified stash and never blindly apply/drop or run bare git stash drop. Quote zsh variables, use brace-delimited Git ref variables, and preserve command exit status instead of hiding it behind a tail pipeline.
These instructions are guidance, not evidence that any check has passed. If no task was supplied, wait for the user's task; do not start integration, cleanup or deployment on your own.
</orca-worktree-policy>

${prompt}`
}
