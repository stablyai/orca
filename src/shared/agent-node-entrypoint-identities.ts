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
  },
  // Why: DSH's npm shim launches a generic `lib/bin.js`, and the launcher re-execs it
  // directly on Windows, so only the package path identifies it. The profile still decides
  // whether the pane is the agent — `dsh web` resolves here too and is filtered after.
  {
    pattern: /(?:^|\/)node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/,
    agent: 'dsh',
    processName: 'dsh'
  }
]
