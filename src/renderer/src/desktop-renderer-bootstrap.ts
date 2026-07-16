import { recordRendererCrashBreadcrumb } from './lib/crash-breadcrumb-recorder'

type DesktopRendererBootstrapOptions = {
  rootElement: HTMLElement | null
  preloadBridgeAvailable: boolean
  loadDesktopRenderer: () => Promise<(rootElement: HTMLElement) => void>
  webClientPath: string | null
}

/**
 * Starts the renderer without returning a floating startup promise. It records
 * early lifecycle breadcrumbs and converts import or mount failures into a
 * token-based retry surface before React diagnostics are available.
 */
export function startDesktopRenderer(options: DesktopRendererBootstrapOptions): void {
  recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: import.meta.env.DEV })
  void bootstrapDesktopRenderer(options)
    .then(() => {
      recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
    })
    .catch((error: unknown) => {
      if (!options.rootElement) {
        recordRendererCrashBreadcrumb('renderer_root_missing')
        return
      }
      recordRendererCrashBreadcrumb('renderer_bootstrap_failed', {
        stage: 'desktop_import',
        errorType: error instanceof Error ? error.name : typeof error
      })
      renderDesktopRendererLoadFailure(options.rootElement)
    })
}

/**
 * Loads Orca's desktop module only when Electron's preload bridge is present.
 * @throws When the root is absent or the desktop module cannot be loaded.
 */
async function bootstrapDesktopRenderer(options: DesktopRendererBootstrapOptions): Promise<void> {
  if (!options.rootElement) {
    throw new Error('Renderer root element not found.')
  }
  if (!options.preloadBridgeAvailable) {
    renderDesktopRendererBrowserNotice(options.rootElement, options.webClientPath)
    return
  }
  const mountDesktopRenderer = await options.loadDesktopRenderer()
  mountDesktopRenderer(options.rootElement)
}

function renderDesktopRendererLoadFailure(rootElement: HTMLElement): void {
  const content = createDesktopNoticeContent(
    'Orca could not start.',
    'The desktop renderer could not load. Retry, or relaunch Orca if the error persists.'
  )
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className =
    'inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  retry.textContent = 'Retry'
  retry.addEventListener('click', () => window.location.reload())
  content.append(retry)
  renderDesktopNotice(rootElement, content)
}

function renderDesktopRendererBrowserNotice(
  rootElement: HTMLElement,
  webClientPath: string | null
): void {
  const content = createDesktopNoticeContent(
    'Open this page from the Orca app.',
    'This address is the Electron renderer and needs Orca’s desktop bridge to run.'
  )
  if (webClientPath) {
    const pairing = document.createElement('p')
    pairing.className = 'text-sm text-muted-foreground'
    pairing.append('For browser pairing, open ')
    const link = document.createElement('a')
    link.className = 'font-medium text-foreground underline underline-offset-4'
    link.href = webClientPath
    link.textContent = webClientPath
    pairing.append(link, '.')
    content.append(pairing)
  }

  renderDesktopNotice(rootElement, content)
}

function createDesktopNoticeContent(titleText: string, descriptionText: string): HTMLDivElement {
  const content = document.createElement('div')
  content.className = 'max-w-md space-y-3 text-center'

  const eyebrow = document.createElement('p')
  eyebrow.className = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground'
  eyebrow.textContent = 'Orca Desktop'

  const title = document.createElement('h1')
  title.className = 'text-lg font-semibold'
  title.textContent = titleText

  const description = document.createElement('p')
  description.className = 'text-sm text-muted-foreground'
  description.textContent = descriptionText
  content.append(eyebrow, title, description)
  return content
}

function renderDesktopNotice(rootElement: HTMLElement, content: HTMLDivElement): void {
  const surface = document.createElement('main')
  surface.className =
    'flex min-h-screen items-center justify-center bg-background px-6 text-foreground'

  surface.append(content)
  rootElement.replaceChildren(surface)
}
