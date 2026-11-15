import { completePluginAppThemeTokens } from '../plugins/artifacts/plugin-theme-artifact'
import type { ThemeStudioMode, ThemeStudioVariant } from './theme-studio-draft'

/** Colors Orca paints when a theme omits them; the specimen needs one value for every part. */
const FALLBACKS: Record<ThemeStudioMode, Record<string, string>> = {
  dark: {
    terminalBackground: '#1e1e1e',
    terminalForeground: '#e6e6e6',
    red: '#f2766b',
    green: '#81b88b',
    yellow: '#e2c08d',
    blue: '#6cb6ff',
    magenta: '#d38bdb',
    cyan: '#56c8d8',
    keyword: '#c586c0',
    string: '#ce9178',
    comment: '#6a9955',
    function: '#dcdcaa'
  },
  light: {
    terminalBackground: '#ffffff',
    terminalForeground: '#1f2328',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    keyword: '#af00db',
    string: '#a31515',
    comment: '#008000',
    function: '#795e26'
  }
}

// Why escape: names are user text, and the specimen is HTML.
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** A color for a syntax scope from the theme's own rules, else Orca's default for the mode. */
function scopeColor(variant: ThemeStudioVariant, scope: string, fallback: string): string {
  const rule = variant.tokenColors?.find((entry) =>
    (Array.isArray(entry.scope) ? entry.scope : [entry.scope]).some((name) =>
      name.startsWith(scope)
    )
  )
  return rule?.settings.foreground ?? fallback
}

/**
 * A self-contained page showing a theme on Orca's parts (sidebar, tabs, editor, terminal, chat)
 * with made-up content, so published images never show the person's own projects or files.
 */
export function themeSpecimenHtml(
  name: string,
  mode: ThemeStudioMode,
  variant: ThemeStudioVariant,
  size: { width: number; height: number }
): string {
  const tokens = completePluginAppThemeTokens(variant.tokens)
  const token = (key: string, fallback: string): string => tokens[key] ?? fallback
  const fallback = FALLBACKS[mode]
  const terminal = variant.terminal ?? {}
  const fg = token('--foreground', mode === 'dark' ? '#f0f0f0' : '#0a0a0a')
  const bg = token('--background', mode === 'dark' ? '#0a0a0a' : '#ffffff')
  const muted = token('--muted-foreground', fg)
  const code = {
    keyword: scopeColor(variant, 'keyword', fallback.keyword),
    string: scopeColor(variant, 'string', fallback.string),
    comment: scopeColor(variant, 'comment', fallback.comment),
    fn: scopeColor(variant, 'entity.name.function', fallback.function)
  }
  const ansi = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const
  const ansiColor = (key: (typeof ansi)[number]): string => terminal[key] ?? fallback[key]
  const css = `
  *{box-sizing:border-box;margin:0}
  body{width:${size.width}px;height:${size.height}px;overflow:hidden;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:${bg};color:${fg};display:grid;grid-template-columns:22% 1fr 20%;grid-template-rows:44px 1fr}
  .title{grid-column:1/4;display:flex;align-items:center;gap:12px;padding:0 18px;background:${token('--tab-bar', token('--card', bg))};border-bottom:1px solid ${token('--border', muted)}}
  .tab{padding:6px 14px;border-radius:7px;color:${token('--tab-inactive-foreground', muted)}}
  .tab.on{background:${token('--tab-active', bg)};color:${token('--tab-active-foreground', fg)};box-shadow:inset 0 -2px 0 ${token('--tab-active-indicator', fg)}}
  .left{background:${token('--worktree-sidebar', bg)};color:${token('--worktree-sidebar-foreground', fg)};padding:18px 12px;border-right:1px solid ${token('--worktree-sidebar-border', 'transparent')}}
  .card{padding:10px 12px;border-radius:10px;margin-bottom:6px}
  .card.on{background:${token('--worktree-sidebar-active', token('--worktree-sidebar-accent', bg))}}
  .badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:${token('--host-badge', token('--accent', bg))};color:${token('--host-badge-foreground', muted)}}
  .dim{color:${muted};font-size:13px}
  .main{display:grid;grid-template-rows:1fr 38%}
  .editor{background:${token('--editor-surface', bg)};padding:20px 24px;font:14.5px/1.7 ui-monospace,Menlo,Consolas,monospace}
  .add{background:${token('--diff-added-background', 'transparent')}}.del{background:${token('--diff-removed-background', 'transparent')}}
  .term{background:${terminal.background ?? fallback.terminalBackground};color:${terminal.foreground ?? fallback.terminalForeground};padding:16px 24px;font:14px/1.7 ui-monospace,Menlo,Consolas,monospace;border-top:1px solid ${token('--border', muted)}}
  .sel{background:${terminal.selectionBackground ?? token('--accent', bg)}}
  .right{background:${token('--sidebar', bg)};color:${token('--sidebar-foreground', fg)};padding:18px 14px;border-left:1px solid ${token('--sidebar-border', 'transparent')}}
  .bubble{margin-top:18px;padding:12px 14px;border-radius:12px;background:${token('--chat-user-message', token('--muted', bg))}}
  .inline{font-family:ui-monospace,Menlo,monospace;padding:0 5px;border-radius:5px;background:${token('--chat-inline-code', token('--muted', bg))};color:${token('--chat-inline-code-foreground', fg)}}
  .btn{display:inline-block;margin-top:16px;padding:7px 14px;border-radius:8px;background:${token('--primary', fg)};color:${token('--primary-foreground', bg)};font-weight:600}
  .link{color:${token('--text-link', fg)}}
  `
  const span = (color: string, text: string): string =>
    `<span style="color:${color}">${text}</span>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="title"><b>${escapeHtml(name)}</b><span class="tab on">theme.ts</span><span class="tab">README.md</span><span class="tab">Terminal</span></div>
  <div class="left">
    <div class="dim" style="margin-bottom:10px">PROJECTS</div>
    <div class="card on"><b>aurora-app</b><br><span class="badge">Local</span> <span class="dim">feature/dark-mode</span></div>
    <div class="card"><b>api-gateway</b><br><span class="dim">main</span></div>
    <div class="card"><b>docs-site</b><br><span style="color:${token('--git-decoration-modified', muted)}">● 3 modified</span></div>
    <div class="card"><b>mobile</b><br><span style="color:${token('--git-decoration-added', muted)}">+ 1 added</span></div>
  </div>
  <div class="main">
    <div class="editor">
      <div>${span(code.comment, '// Orca theme specimen')}</div>
      <div>${span(code.keyword, 'export function')} ${span(code.fn, 'greet')}(name: string) {</div>
      <div class="del">&nbsp;&nbsp;${span(code.keyword, 'return')} ${span(code.string, "'Hello'")}</div>
      <div class="add">&nbsp;&nbsp;${span(code.keyword, 'return')} ${span(code.string, '`Hello, ${name}!`')}</div>
      <div>}</div>
    </div>
    <div class="term">
      <div>$ npm test</div>
      <div>${span(ansiColor('green'), '✓ 42 passed')} ${span(ansiColor('yellow'), '⚠ 1 skipped')} ${span(ansiColor('red'), '✗ 0 failed')}</div>
      <div>${ansi.map((key) => span(ansiColor(key), '■■')).join(' ')}</div>
      <div><span class="sel">selected text</span> ${span(ansiColor('blue'), '~/aurora-app')} ${span(ansiColor('magenta'), 'main')} ${span(ansiColor('cyan'), '↑2')}</div>
    </div>
  </div>
  <div class="right">
    <div class="dim">AGENT</div>
    <div class="bubble">Make the sidebar warmer and keep it readable.</div>
    <p style="margin-top:14px">Updated <span class="inline">--worktree-sidebar</span> and checked contrast in both modes. <span class="link">View diff</span></p>
    <span class="btn">Keep</span>
  </div>
  </body></html>`
}
