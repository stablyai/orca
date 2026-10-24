import {
  httpLinkActionDestinationsFor,
  type HttpLinkActionDestinations
} from '@/lib/http-link-destinations'
import { useAppStore } from '@/store'

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

/** A local HTML file is a page, so it opens where http links do. */
export function localHtmlFileDestinations(): HttpLinkActionDestinations {
  return httpLinkActionDestinationsFor(useAppStore.getState().settings, { kind: 'local' }, false)
}
