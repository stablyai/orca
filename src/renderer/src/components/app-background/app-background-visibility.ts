import { resolveAppBackgroundAppearance } from '@/lib/app-background-appearance'
import { isWebClientLocation } from '@/lib/web-client-location'
import { peekSettledAppBackgroundBlobUrl } from './app-background-blob-cache'
import { useAppBackgroundBlobState } from './AppBackgroundLayer'

type AppBackgroundSettings = Parameters<typeof resolveAppBackgroundAppearance>[0]

/** Same gate as the host attribute: an applied image whose bytes have loaded. */
export function isAppBackgroundImageShowing(settings: AppBackgroundSettings): boolean {
  const appearance = resolveAppBackgroundAppearance(settings, isWebClientLocation())
  if (!appearance) {
    return false
  }
  return Boolean(peekSettledAppBackgroundBlobUrl({ id: appearance.imageId })?.url)
}

/** Reactive isAppBackgroundImageShowing; takes settings the caller already holds so it adds no store listener. */
export function useAppBackgroundImageShowing(settings: AppBackgroundSettings): boolean {
  const appearance = resolveAppBackgroundAppearance(settings, isWebClientLocation())
  return (
    useAppBackgroundBlobState(appearance ? { id: appearance.imageId } : null)?.status === 'loaded'
  )
}
