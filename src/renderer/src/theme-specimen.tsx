import './assets/main.css'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { completePluginAppThemeTokens } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import type { ThemeStudioMode } from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_SPECIMEN_FAILED_TITLE,
  THEME_STUDIO_SPECIMEN_PANEL,
  THEME_STUDIO_SPECIMEN_READY_TITLE,
  themeStudioSpecimenRequestSchema,
  type ThemeStudioSpecimenRequest
} from '../../shared/theme-studio/theme-studio-specimen-request'
import { applyPluginAppTheme } from './app-shell/appearance/document-theme'
import { themeBuiltInTokens } from './app-shell/appearance/theme-built-in-tokens'
import { SpecimenChat, SpecimenDialog } from './components/theme-specimen/SpecimenChat'
import { SpecimenEditor } from './components/theme-specimen/SpecimenEditor'
import { SpecimenSidebar } from './components/theme-specimen/SpecimenSidebar'
import { SpecimenTerminal } from './components/theme-specimen/SpecimenTerminal'

// A hidden window (never shown or focused) loads this page to draw a theme on Orca's own parts
// with made-up content, so `orca theme specimen` shows both modes without switching Orca. Each
// mode is its own document (an iframe), painted on <html> exactly as the app paints, so tokens
// main.css derives on :root follow the theme.

type Panel = ThemeStudioSpecimenRequest['panels'][number]

function readRequest(): ThemeStudioSpecimenRequest | null {
  try {
    const base64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/')
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    )
    const parsed = themeStudioSpecimenRequestSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Waits for fonts and two frames: the first commits the tokens, the second paints with them. */
async function painted(): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

function PanelDocument({ name, panel }: { name: string; panel: Panel }): React.JSX.Element {
  const { mode, variant } = panel
  useEffect(() => {
    void painted().then(() => window.parent.postMessage({ specimenPanel: mode }, '*'))
  }, [mode])
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-tab-bar px-3 text-[13px]">
        <span className="mr-2 font-semibold">{name}</span>
        <span
          className="rounded-md px-3 py-1"
          style={{
            background: 'var(--tab-active)',
            color: 'var(--tab-active-foreground)',
            boxShadow: 'inset 0 -2px 0 var(--tab-active-indicator)'
          }}
        >
          greet.ts
        </span>
        <span className="px-3 py-1" style={{ color: 'var(--tab-inactive-foreground)' }}>
          README.md
        </span>
        <span className="ml-auto text-[11px] tracking-wide text-muted-foreground uppercase">
          {mode}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <SpecimenSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <SpecimenEditor variant={variant} />
          <SpecimenTerminal mode={mode} terminal={variant?.terminal} base={panel.terminalBase} />
        </div>
        <div className="relative flex w-[30%] shrink-0 flex-col border-l border-border bg-sidebar text-sidebar-foreground">
          <SpecimenChat />
          <SpecimenDialog />
        </div>
      </div>
    </div>
  )
}

/** Paints one mode on this document's <html>, the way the app paints its window. */
function paintDocument(mode: ThemeStudioMode, panel: Panel): void {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  document.documentElement.style.colorScheme = mode
  applyPluginAppTheme(
    panel.variant
      ? {
          id: `specimen-${mode}`,
          revision: '0',
          base: mode,
          tokens: completePluginAppThemeTokens(panel.variant.tokens)
        }
      : null,
    { storage: null, builtIns: () => themeBuiltInTokens(mode) }
  )
}

function SpecimenFrames({ request }: { request: ThemeStudioSpecimenRequest }): React.JSX.Element {
  useEffect(() => {
    const waiting = new Set(request.panels.map((panel) => panel.mode))
    const onMessage = (event: MessageEvent): void => {
      const mode: unknown =
        typeof event.data === 'object' && event.data !== null && 'specimenPanel' in event.data
          ? event.data.specimenPanel
          : null
      if (mode === 'light' || mode === 'dark') {
        waiting.delete(mode)
      }
      if (waiting.size === 0) {
        document.title = THEME_STUDIO_SPECIMEN_READY_TITLE
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [request])
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {request.panels.map((panel) => (
        <iframe
          key={panel.mode}
          title={panel.mode}
          className="h-full min-w-0 flex-1 border-0"
          src={`${location.pathname}?${THEME_STUDIO_SPECIMEN_PANEL}=${panel.mode}${location.hash}`}
        />
      ))}
    </div>
  )
}

const request = readRequest()
const container = document.getElementById('root')
const panelMode = new URLSearchParams(location.search).get(THEME_STUDIO_SPECIMEN_PANEL)
const panel = request?.panels.find((entry) => entry.mode === panelMode)
if (!request || !container) {
  document.title = THEME_STUDIO_SPECIMEN_FAILED_TITLE
} else if (panel) {
  paintDocument(panel.mode, panel)
  createRoot(container).render(
    <StrictMode>
      <PanelDocument name={request.name} panel={panel} />
    </StrictMode>
  )
} else {
  createRoot(container).render(
    <StrictMode>
      <SpecimenFrames request={request} />
    </StrictMode>
  )
}
