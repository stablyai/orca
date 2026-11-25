// Require resolved package paths: even agent-named scripts can belong to unrelated Node apps. Keep entrypoint data separate from recognition logic.
export const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  codebuddy: ['node_modules/@tencent-ai/codebuddy-code/'],
  // npm ZCode runs as Node dist/zcode.cjs; only SEA builds expose the foreground name.
  zcode: ['node_modules/@zcode/cli/'],
  // DSH's PATH launcher re-execs its profile-installed copy by absolute path.
  'dsh-tui': ['node_modules/@deepseek-harness-tui/dsh-tui/'],
  // dima's Windows launcher stays Node (bin/dimcode.mjs) around its native child; the TypeScript `dimcode` package is unrelated.
  dimcode: ['node_modules/dimcode-alpha/'],
  dsb: ['node_modules/@innocarpe/deepseek-build/'],
  'deepseek-build': ['node_modules/@innocarpe/deepseek-build/']
}
