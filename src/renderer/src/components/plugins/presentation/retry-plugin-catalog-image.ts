import { parsePluginImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'

export function retryPluginCatalogImage(image: HTMLImageElement): boolean {
  const url = new URL(image.src)
  if (url.searchParams.has('retry') || parsePluginImageUrl(url.href)?.kind !== 'catalog') {
    return false
  }
  url.searchParams.set('retry', '1')
  image.src = url.href
  return true
}
