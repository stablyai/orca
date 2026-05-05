export function shouldAutoCreateInitialTerminal(renderableTabCount: number): boolean {
  // Why: the tab-group model is now the source of truth for visible worktree
  // content. If it has no renderable tabs, the workspace must synthesize a
  // terminal instead of deferring to legacy editor/browser restore state,
  // which can otherwise leave an empty split group with nothing mounted.
  return renderableTabCount === 0
}
