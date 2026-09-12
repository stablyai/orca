import type { TuiAgent } from './tui-agent'

// Node CLIs whose shims launch a generic script (cli.js, versioned index.js), so
// only the exact install path is an authoritative identity signal.
export const EXACT_NODE_ENTRYPOINT_IDENTITIES: readonly {
  pattern: RegExp
  agent: TuiAgent
  processName: string
}[] = [
  // Why: Cursor's native Windows launcher runs a generic versioned index.js,
  // so its install path is the only stable identity that avoids ordinary Node apps.
  {
    pattern: /(?:^|\/)cursor-agent\/versions\/[^/]+\/index\.js$/,
    agent: 'cursor',
    processName: 'cursor-agent'
  },
  // Why: Qwen's npm shim runs a generic cli-entry.js under Node.
  {
    pattern: /(?:^|\/)node_modules\/@qwen-code\/qwen-code\/(?:scripts\/)?cli-entry\.js$/,
    agent: 'qwen-code',
    processName: 'qwen'
  },
  // Why: the standalone launcher lives under the standard per-user LocalAppData root.
  {
    pattern: /^[a-z]:\/users\/[^/]+\/appdata\/local\/qwen-code\/qwen-code\/lib\/cli-entry\.js$/,
    agent: 'qwen-code',
    processName: 'qwen'
  },
  // Why: Pi's npm shim launches a generic cli.js; only the exact package path is authoritative.
  {
    pattern:
      /(?:^|\/)node_modules\/@(?:earendil-works|mariozechner)\/pi-coding-agent\/dist\/cli\.js$/,
    agent: 'pi',
    processName: 'pi'
  },
  // Why: same shape as Pi — Prime Agent's npm shim launches a generic bundled cli.js.
  {
    pattern: /(?:^|\/)node_modules\/prime-agent\/dist\/bundle\/cli\.js$/,
    agent: 'prime-agent',
    processName: 'prime-agent'
  }
]
