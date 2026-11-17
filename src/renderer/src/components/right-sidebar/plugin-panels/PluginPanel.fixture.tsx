import { defineFixture } from '../../../component-fixtures/component-fixture'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { buildPluginPanelShellHtml } from '../../../../../shared/plugins/frames/plugin-panel-shell'
import {
  codeEditorSyntaxColors,
  paintCodeEditorSyntaxColors
} from '@/lib/editor/appearance/code-editor-syntax-colors'
import { derivePluginMonacoTheme } from '@/lib/editor/appearance/plugin-monaco-theme'
import { browserColorProbe } from '@/app-shell/appearance/plugin-theme-tokens'
import type { PluginThemeTokenColorRule } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import githubDark from '../../../../../../resources/plugins/launch/stablyai.orca-github-vscode-theme/themes/github-dark-default.json'
import PluginPanel from './PluginPanel'

function installPanel(body: string): void {
  usePluginPanelsStore.getState().setPlugins([
    {
      pluginKey: 'samples.layout',
      consentFingerprint: 'fixture',
      name: 'Layout',
      version: '1.0.0',
      publisher: 'samples',
      status: 'idle',
      needsReconsent: false,
      isDev: false,
      official: false,
      bundled: false,
      capabilities: [],
      panels: [{ id: 'panel', title: 'Layout', tabKey: 'plugin:samples.layout/panel' }],
      commands: [],
      hasWorker: false,
      restarts: 0
    }
  ])
  window.api = {
    ...window.api,
    plugins: {
      ...window.api.plugins,
      readPanelEntry: async () => ({
        html: buildPluginPanelShellHtml(body),
        sessionToken: 'fixture'
      })
    }
  }
}

export const compact = defineFixture({
  width: 280,
  setup() {
    installPanel(
      '<body style="margin:0;color:var(--orca-foreground);background:var(--orca-background)"><div style="height:100vh;box-sizing:border-box;border:1px solid var(--orca-border);display:flex;align-items:end">Panel bottom</div></body>'
    )
  },
  render: () => (
    <div className="flex h-32 flex-col overflow-hidden">
      <div className="h-9 shrink-0 border-b border-border">Plugin sidebar</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PluginPanel tabKey="plugin:samples.layout/panel" />
      </div>
    </div>
  )
})

const span = (color: string, text: string): string =>
  `<span style="color:var(--orca-syntax-${color})">${text}</span>`

// A panel that colors code only with the frame's syntax variables, as a diff or blame view would.
const SYNTAX_PANEL = `<body style="margin:0;padding:8px;color:var(--orca-foreground);background:var(--orca-background);font:12px/1.6 var(--orca-font-mono)"><pre style="margin:0">${[
  span('comment', '// Colored by the code editor theme'),
  `${span('keyword', 'export function')} ${span('function', 'greet')}(${span('variable', 'name')}${span('operator', ':')} ${span('type', 'string')}) {`,
  `  ${span('keyword', 'const')} ${span('variable', 'times')} ${span('operator', '=')} ${span('number', '3')}`,
  `  ${span('keyword', 'return')} ${span('string', "'hi '")} ${span('operator', '+')} ${span('variable', 'name')} ${span('operator', '+')} ${span('constant', 'undefined')}`,
  '}',
  `${span('tag', '&lt;Badge')} ${span('attribute', 'tone')}${span('operator', '=')}${span('string', '"info"')} ${span('tag', '/&gt;')}`
].join('\n')}</pre></body>`

const renderSyntaxPanel = () => (
  <div className="flex h-44 flex-col overflow-hidden">
    <PluginPanel tabKey="plugin:samples.layout/panel" />
  </div>
)

// Why paint in setup: the fixture page skips useDocumentAppearance, which paints them in the app.
export const syntaxColors = defineFixture({
  width: 420,
  setup() {
    const base = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    paintCodeEditorSyntaxColors(codeEditorSyntaxColors({ monaco: null, override: null }, base))
    installPanel(SYNTAX_PANEL)
  },
  render: renderSyntaxPanel
})

/** Shoot with `--theme dark`: a bundled plugin theme recolors the panel's code with the app. */
export const syntaxColorsGitHubDark = defineFixture({
  width: 420,
  setup() {
    const root = document.documentElement
    for (const [token, value] of Object.entries(githubDark.tokens)) {
      root.style.setProperty(token, value)
    }
    const styles = getComputedStyle(root)
    const monaco = derivePluginMonacoTheme({
      base: 'dark',
      read: (token) => styles.getPropertyValue(token),
      painted: githubDark.tokens,
      probe: browserColorProbe,
      tokenColors: githubDark.tokenColors as PluginThemeTokenColorRule[]
    })
    paintCodeEditorSyntaxColors(codeEditorSyntaxColors({ monaco, override: null }, 'dark'))
    installPanel(SYNTAX_PANEL)
  },
  render: renderSyntaxPanel
})
