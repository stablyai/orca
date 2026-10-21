import { resolveOpaqueTerminalBackground } from '@/lib/terminal-theme'
import { resolveTranslucentPaneTitleBackground } from '@/lib/app-background-appearance'
import { useAppBackgroundImageShowing } from '@/components/app-background/app-background-visibility'

type PaneTitleSettings = NonNullable<Parameters<typeof useAppBackgroundImageShowing>[0]> & {
  terminalBackgroundOpacity?: number
}

export function usePaneTitleBackground({
  settings,
  terminalBackground,
  appSurface,
  titleUsesLightSurface
}: {
  settings: PaneTitleSettings | null | undefined
  terminalBackground: string | undefined
  appSurface: 'dark' | 'light' | undefined
  titleUsesLightSurface: boolean
}): string {
  // Why the loaded gate: a missing image file must leave titles opaque, like every other panel.
  const imageShowing = useAppBackgroundImageShowing(settings)
  const backgroundOpacity = settings?.terminalBackgroundOpacity
  return (
    // Why: over a background image the opaque composite would hide the image the terminal lets through.
    (imageShowing
      ? resolveTranslucentPaneTitleBackground(terminalBackground, backgroundOpacity)
      : null) ??
    resolveOpaqueTerminalBackground(terminalBackground, { appSurface, backgroundOpacity }) ??
    (titleUsesLightSurface ? '#ffffff' : '#000000')
  )
}
