import { useAppStore } from '@/store/index'
import {
  openAppHttpLink,
  type OpenAppHttpLinkOptions
} from '@/lib/browser/navigation/app-http-link-open'

// Why: an in-app link would leave Settings and drop its unsaved draft; the system browser keeps the page as is.
export function openHelpLink(url: string, options: OpenAppHttpLinkOptions = {}): void {
  openAppHttpLink(
    url,
    useAppStore.getState().activeView === 'settings'
      ? { ...options, destination: 'system' }
      : options
  )
}
