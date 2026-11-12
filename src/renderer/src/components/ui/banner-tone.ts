// GA-P3t (Neil): one look for strips, banners and notices by severity, so none blends into a white
// pane. The colours live in main.css (--banner-*), measured for contrast in light and dark.
export type BannerSeverity = 'warning' | 'error' | 'info'

export const BANNER_TONE: Record<
  BannerSeverity,
  { surface: string; border: string; icon: string }
> = {
  warning: {
    surface: 'bg-banner-warning-fill',
    border: 'border-banner-warning-border',
    icon: 'text-banner-warning-icon'
  },
  error: {
    surface: 'bg-banner-error-fill',
    border: 'border-banner-error-border',
    icon: 'text-banner-error-icon'
  },
  info: {
    surface: 'bg-banner-info-fill',
    border: 'border-banner-info-border',
    icon: 'text-banner-info-icon'
  }
}

/** Body and detail text inside a banner: darker than muted, so it clears 4.5:1 on any fill. */
export const BANNER_BODY_TEXT = 'text-banner-body'
