import type { TuiAgent } from './tui-agent'

// Node CLIs whose shims launch a generic script (cli.js, versioned index.js), so
// only the exact install path is an authoritative identity signal.
export const EXACT_NODE_ENTRYPOINT_IDENTITIES: readonly {
  pattern: RegExp
  agent: TuiAgent
  processName: string
}[] = [
  // Cursor's versioned index.js is generic; only its install path distinguishes ordinary Node apps.
  {
    pattern: /(?:^|\/)cursor-agent\/versions\/[^/]+\/index\.js$/,
    agent: 'cursor',
    processName: 'cursor-agent'
  },
  // npm Claude's historical cli.js still appears behind pnpm/yarn/npx shims.
  {
    pattern: /(?:^|\/)node_modules\/@anthropic-ai\/claude-code\/cli\.js$/,
    agent: 'claude',
    processName: 'claude'
  },
  // Pi cli.js is generic; require the package path.
  {
    pattern:
      /(?:^|\/)node_modules\/@(?:earendil-works|mariozechner)\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js$/,
    agent: 'pi',
    processName: 'pi'
  },
  // Prime Agent also uses a generic bundled cli.js.
  {
    pattern: /(?:^|\/)node_modules\/prime-agent\/dist\/bundle\/cli\.js$/,
    agent: 'prime-agent',
    processName: 'prime-agent'
  },
  // DSH re-execs generic lib/bin.js on Windows; package identity still requires later profile filtering for dsh web.
  {
    pattern: /(?:^|\/)node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/,
    agent: 'dsh',
    processName: 'dsh'
  },
  // Why: Qwen's npm bin is a generic `cli-entry` script that re-runs `cli` in a child node on
  // Windows; the standalone installer ships the same pair under `qwen-code/lib/`.
  {
    pattern:
      /(?:^|\/)(?:node_modules\/@qwen-code\/qwen-code\/(?:cli-entry|cli|scripts\/cli-entry|dist\/cli)|qwen-code\/lib\/cli(?:-entry)?)\.js$/,
    agent: 'qwen-code',
    processName: 'qwen'
  },
  // Why: Kimi Code's npm bin is a generic `dist/main.mjs`, and on Windows its process stays
  // node.exe instead of retitling to `kimi-code`, so only the package path identifies it.
  {
    pattern: /(?:^|\/)node_modules\/@moonshot-ai\/kimi-code\/dist\/main\.mjs$/,
    agent: 'kimi',
    processName: 'kimi'
  }
]
