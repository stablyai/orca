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

// Why escape names only: colors reach this page already checked as color values by the theme
// schemas (no `;`, braces or url()), and names are free text.
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
  const git = (key: string): string => token(`--git-decoration-${key}`, muted)
  const css = `
  *{box-sizing:border-box;margin:0}
  body{width:${size.width}px;height:${size.height}px;overflow:hidden;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:${bg};color:${fg};display:grid;grid-template-columns:20% 1fr 25%;grid-template-rows:44px 1fr}
  .title{grid-column:1/4;display:flex;align-items:center;gap:10px;padding:0 16px;background:${token('--tab-bar', token('--card', bg))};border-bottom:1px solid ${token('--border', muted)}}
  .tab{padding:6px 14px;border-radius:7px;color:${token('--tab-inactive-foreground', muted)}}
  .tab.on{background:${token('--tab-active', bg)};color:${token('--tab-active-foreground', fg)};box-shadow:inset 0 -2px 0 ${token('--tab-active-indicator', fg)}}
  .left{background:${token('--worktree-sidebar', bg)};color:${token('--worktree-sidebar-foreground', fg)};padding:14px 10px;border-right:1px solid ${token('--worktree-sidebar-border', 'transparent')};overflow:hidden}
  .card{padding:8px 10px;border-radius:9px;margin-bottom:4px}
  .card.on{background:${token('--worktree-sidebar-active', token('--worktree-sidebar-accent', bg))}}
  .badge{display:inline-block;font-size:11px;padding:0 7px;border-radius:999px;background:${token('--host-badge', token('--accent', bg))};color:${token('--host-badge-foreground', muted)}}
  .dim{color:${muted};font-size:12px}
  .head{font-size:11px;letter-spacing:.06em;color:${muted};margin:12px 4px 6px}
  .file{display:flex;justify-content:space-between;padding:3px 6px;font-size:13px}
  .main{display:grid;grid-template-rows:58% 42%;min-height:0}
  .editor{background:${token('--editor-surface', bg)};padding:14px 0;font:13.5px/1.62 ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
  .ln{display:inline-block;width:46px;padding-right:14px;text-align:right;color:${muted};opacity:.7}
  .add{background:${token('--diff-added-background', 'transparent')}}.del{background:${token('--diff-removed-background', 'transparent')}}
  .term{background:${terminal.background ?? fallback.terminalBackground};color:${terminal.foreground ?? fallback.terminalForeground};padding:12px 20px;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;border-top:1px solid ${token('--border', muted)};overflow:hidden}
  .sel{background:${terminal.selectionBackground ?? token('--accent', bg)}}
  .right{background:${token('--sidebar', bg)};color:${token('--sidebar-foreground', fg)};padding:14px;border-left:1px solid ${token('--sidebar-border', 'transparent')};overflow:hidden;display:flex;flex-direction:column;gap:12px}
  .bubble{padding:10px 12px;border-radius:12px;background:${token('--chat-user-message', token('--muted', bg))};align-self:flex-end;max-width:90%}
  .inline{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;padding:0 5px;border-radius:5px;background:${token('--chat-inline-code', token('--muted', bg))};color:${token('--chat-inline-code-foreground', fg)}}
  .block{font:12.5px/1.55 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:8px;background:${token('--chat-code-block', token('--muted', bg))}}
  .bold{color:${token('--chat-bold-foreground', fg)};font-weight:600}
  .btn{display:inline-block;padding:6px 14px;border-radius:8px;background:${token('--primary', fg)};color:${token('--primary-foreground', bg)};font-weight:600}
  .btn2{display:inline-block;padding:6px 14px;border-radius:8px;background:${token('--secondary', token('--muted', bg))};color:${token('--secondary-foreground', fg)};margin-left:6px}
  .link{color:${token('--text-link', fg)}}
  .tool{font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid ${token('--border', muted)};color:${muted}}
  .composer{margin-top:auto;padding:10px 12px;border-radius:10px;border:1px solid ${token('--input', token('--border', muted))};background:${token('--card', bg)};color:${muted}}
  .agent{display:flex;align-items:center;gap:8px;padding:4px 6px;font-size:13px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  `
  const span = (color: string, text: string): string =>
    `<span style="color:${color}">${text}</span>`
  const kw = (text: string): string => span(code.keyword, text)
  const str = (text: string): string => span(code.string, text)
  const fnName = (text: string): string => span(code.fn, text)
  const comment = (text: string): string => span(code.comment, text)
  const editorLines: [string, string?][] = [
    [comment('// Greets each visitor and remembers when they came back.')],
    [`${kw('import')} { ${fnName('formatDistance')} } ${kw('from')} ${str("'./time'")}`],
    [''],
    [`${kw('export interface')} Visitor {`],
    ['&nbsp;&nbsp;name: string'],
    ['&nbsp;&nbsp;lastSeen?: Date'],
    ['}'],
    [''],
    [`${kw('export function')} ${fnName('greet')}(visitor: Visitor): string {`],
    [`&nbsp;&nbsp;${kw('return')} ${str("'Hello'")}`, 'del'],
    [
      `&nbsp;&nbsp;${kw('if')} (!visitor.lastSeen) ${kw('return')} ${str('`Welcome, ${visitor.name}!`')}`,
      'add'
    ],
    [
      `&nbsp;&nbsp;${kw('const')} ago = ${fnName('formatDistance')}(visitor.lastSeen, ${kw('new')} Date())`,
      'add'
    ],
    [
      `&nbsp;&nbsp;${kw('return')} ${str('`Welcome back, ${visitor.name}. Last visit: ${ago} ago.`')}`,
      'add'
    ],
    ['}'],
    [''],
    [comment('// Used by the home page and the mobile app.')],
    [
      `${kw('export const')} ${fnName('greetAll')} = (list: Visitor[]) => list.${fnName('map')}(${fnName('greet')})`
    ],
    [''],
    [`${kw('export function')} ${fnName('isNew')}(visitor: Visitor): boolean {`],
    [`&nbsp;&nbsp;${kw('return')} visitor.lastSeen === ${kw('undefined')}`],
    ['}'],
    [''],
    [`${kw('export default')} { greet, greetAll, isNew }`]
  ]
  const editor = editorLines
    .map(
      ([line, kind], index) =>
        `<div${kind ? ` class="${kind}"` : ''}><span class="ln">${index + 1}</span>${line}</div>`
    )
    .join('')
  const files: [string, string, string][] = [
    ['greet.ts', 'M', git('modified')],
    ['time.ts', 'A', git('added')],
    ['greet.test.ts', 'M', git('modified')],
    ['legacy-hello.ts', 'D', git('deleted')],
    ['notes.md', 'U', git('untracked')],
    ['README.md', 'M', git('modified')],
    ['package.json', 'M', git('modified')]
  ]
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="title"><b>${escapeHtml(name)}</b><span class="tab on">greet.ts</span><span class="tab">time.ts</span><span class="tab">README.md</span><span class="tab">Terminal</span></div>
  <div class="left">
    <div class="head">PROJECTS</div>
    <div class="card on"><b>aurora-app</b><br><span class="badge">Local</span> <span class="dim">feature/welcome-back</span></div>
    <div class="card"><b>api-gateway</b><br><span class="badge">SSH</span> <span class="dim">main</span></div>
    <div class="card"><b>docs-site</b><br>${span(git('modified'), '● 3 modified')}</div>
    <div class="card"><b>mobile</b><br>${span(git('added'), '+ 1 added')}</div>
    <div class="card"><b>design-tokens</b><br><span class="dim">release/2.4</span></div>
    <div class="head">CHANGES</div>
    ${files.map(([file, mark, color]) => `<div class="file">${span(color, file)}${span(color, mark)}</div>`).join('')}
    <div class="head">AGENTS</div>
    <div class="agent"><span class="dot" style="background:${ansiColor('green')}"></span>aurora-app · tests passing</div>
    <div class="agent"><span class="dot" style="background:${ansiColor('yellow')}"></span>docs-site · waiting for you</div>
    <div class="agent"><span class="dot" style="background:${ansiColor('blue')}"></span>mobile · writing code</div>
  </div>
  <div class="main">
    <div class="editor">${editor}</div>
    <div class="term">
      <div>${span(ansiColor('blue'), '~/aurora-app')} ${span(ansiColor('magenta'), 'feature/welcome-back')} ${span(ansiColor('cyan'), '↑2')} $ npm test</div>
      <div>${span(ansiColor('green'), ' ✓')} greet › welcomes a first visitor ${span(muted, '(3 ms)')}</div>
      <div>${span(ansiColor('green'), ' ✓')} greet › says when they last came ${span(muted, '(2 ms)')}</div>
      <div>${span(ansiColor('green'), ' ✓')} greetAll › keeps the order ${span(muted, '(1 ms)')}</div>
      <div>${span(ansiColor('yellow'), ' ○')} skipped › greets in French</div>
      <div>Tests: ${span(ansiColor('green'), '42 passed')}, ${span(ansiColor('yellow'), '1 skipped')}, ${span(ansiColor('red'), '0 failed')}</div>
      <div>${span(ansiColor('blue'), '~/aurora-app')} $ git status --short</div>
      <div>${span(ansiColor('red'), ' M')} src/greet.ts&nbsp;&nbsp;${span(ansiColor('green'), 'A')}&nbsp; src/time.ts&nbsp;&nbsp;${span(ansiColor('red'), '??')} notes.md</div>
      <div>${ansi.map((key) => span(ansiColor(key), '■■■')).join(' ')}</div>
      <div>${span(ansiColor('blue'), '~/aurora-app')} $ npm run dev</div>
      <div>${span(ansiColor('cyan'), '  ➜')}  Local:   ${span(ansiColor('cyan'), 'http://localhost:5173/')}</div>
      <div>${span(ansiColor('magenta'), '  ➜')}  Network: ${span(muted, 'use --host to expose')}</div>
      <div><span class="sel">selected text</span> ${span(ansiColor('cyan'), 'ready in 412 ms')}</div>
      <div>${span(ansiColor('yellow'), 'warning')} unused import ${span(ansiColor('cyan'), "'addDays'")} in src/time.ts:2</div>
    </div>
  </div>
  <div class="right">
    <div class="dim">AGENT</div>
    <div class="bubble">Welcome returning visitors back and say when they last came.</div>
    <div>Updated <span class="inline">greet()</span> to use <span class="inline">formatDistance</span>. <span class="bold">All 42 tests pass.</span></div>
    <div class="block">${kw('if')} (!visitor.lastSeen) {<br>&nbsp;&nbsp;${kw('return')} ${str('`Welcome!`')}<br>}</div>
    <div>Review the change in <span class="link">greet.ts</span> or open the <span class="link">diff</span>.</div>
    <div class="tool">✓ Ran npm test · 42 passed, 1 skipped</div>
    <div class="tool">✎ Edited greet.ts ${span(git('added'), '+4')} ${span(git('deleted'), '−1')} · time.ts ${span(git('added'), '+12')}</div>
    <div class="bubble">Looks good. Ship it.</div>
    <div>Committed as <span class="inline">feat: welcome back</span> on <span class="bold">feature/welcome-back</span>.</div>
    <div><span class="btn">Open pull request</span><span class="btn2">View diff</span></div>
    <div class="composer">Ask the agent…</div>
  </div>
  </body></html>`
}
