// Require resolved package paths: even agent-named scripts can belong to unrelated Node apps. Keep entrypoint data separate from recognition logic.
export const NODE_PACKAGE_SCRIPT_ENTRYPOINTS: Record<string, readonly string[]> = {
  codex: ['node_modules/@openai/codex/'],
  codebuddy: ['node_modules/@tencent-ai/codebuddy-code/'],
  // npm ZCode runs as Node dist/zcode.cjs; only SEA builds expose the foreground name.
  // Why vendor/ only: zcode-app-cli's bin/zcode.js launcher shares the runtime's process group, and a same-group zcode ancestor would make hook ownership unprovable.
  zcode: ['node_modules/@zcode/cli/', 'node_modules/zcode-app-cli/vendor/'],
  // DSH's PATH launcher re-execs its profile-installed copy by absolute path.
  'dsh-tui': ['node_modules/@deepseek-harness-tui/dsh-tui/'],
  dsb: ['node_modules/@innocarpe/deepseek-build/'],
  'deepseek-build': ['node_modules/@innocarpe/deepseek-build/']
}
