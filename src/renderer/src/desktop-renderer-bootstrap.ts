type DesktopRendererBootstrapOptions = {
  rootElement: HTMLElement | null
  preloadBridgeAvailable: boolean
  loadDesktopRenderer: () => Promise<unknown>
  webClientPath: string | null
}

/**
 * Loads Orca's desktop renderer only after Electron has installed its preload bridge.
 */
export async function bootstrapDesktopRenderer(
  options: DesktopRendererBootstrapOptions
): Promise<void> {
  if (!options.rootElement) {
    throw new Error('Renderer root element not found.')
  }
  if (!options.preloadBridgeAvailable) {
    renderDesktopRendererBrowserNotice(options.rootElement, options.webClientPath)
    return
  }
  await options.loadDesktopRenderer()
}

function renderDesktopRendererBrowserNotice(
  rootElement: HTMLElement,
  webClientPath: string | null
): void {
  const surface = document.createElement('main')
  surface.className =
    'flex min-h-screen items-center justify-center bg-background px-6 text-foreground'

  const content = document.createElement('div')
  content.className = 'max-w-md space-y-3 text-center'

  const eyebrow = document.createElement('p')
  eyebrow.className = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground'
  eyebrow.textContent = 'Orca Desktop'

  const title = document.createElement('h1')
  title.className = 'text-lg font-semibold'
  title.textContent = 'Open this page from the Orca app.'

  const description = document.createElement('p')
  description.className = 'text-sm text-muted-foreground'
  description.textContent =
    'This address is the Electron renderer and needs Orca’s desktop bridge to run.'

  content.append(eyebrow, title, description)
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

  surface.append(content)
  rootElement.replaceChildren(surface)
}
