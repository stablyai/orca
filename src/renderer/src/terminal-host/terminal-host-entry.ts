// Entry for the isolated terminal host page (terminal-host.html), loaded in a
// <webview> so the terminal renders in its own process. Config arrives via URL
// query params — static at load time, so there is no init-message race.
import {
  startTerminalHost,
  type TerminalHostConfig,
  type TerminalHostStartup
} from './terminal-host-controller'
import { startTerminalHostProbe } from './terminal-host-probe'

function parseConfig(): TerminalHostConfig {
  const params = new URLSearchParams(window.location.search)
  let theme: TerminalHostConfig['theme'] = null
  const rawTheme = params.get('theme')
  if (rawTheme) {
    try {
      theme = JSON.parse(rawTheme)
    } catch {
      theme = null
    }
  }
  let startup: TerminalHostStartup | undefined
  const rawStartup = params.get('startup')
  if (rawStartup) {
    try {
      startup = JSON.parse(rawStartup) as TerminalHostStartup
    } catch {
      startup = undefined
    }
  }
  const fontSize = Number(params.get('fontSize'))
  const lineHeight = Number(params.get('lineHeight'))
  const cursorStyle = params.get('cursorStyle')
  return {
    cwd: params.get('cwd') ?? '',
    worktreeId: params.get('worktreeId') ?? undefined,
    tabId: params.get('tabId') ?? undefined,
    leafId: params.get('leafId') ?? undefined,
    startup,
    theme,
    fontFamily: params.get('fontFamily') ?? 'monospace',
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 13,
    ...(Number.isFinite(lineHeight) && lineHeight > 0 ? { lineHeight } : {}),
    ...(cursorStyle === 'block' || cursorStyle === 'underline' || cursorStyle === 'bar'
      ? { cursorStyle }
      : {}),
    cursorBlink: params.get('cursorBlink') === '1'
  }
}

const container = document.getElementById('terminal')
if (container) {
  const config = parseConfig()
  startTerminalHostProbe(config.worktreeId ?? config.cwd)
  void startTerminalHost(container, config).catch((error) => {
    container.textContent = `Terminal host failed to start: ${
      error instanceof Error ? error.message : String(error)
    }`
  })
}
