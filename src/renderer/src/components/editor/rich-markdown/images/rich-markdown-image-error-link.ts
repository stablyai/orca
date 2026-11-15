import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

export function attachRichMarkdownImageErrorLink(
  container: HTMLElement,
  image: HTMLImageElement,
  getSource: () => string | undefined
): { update: (sourceChanged: boolean) => void } {
  const link = document.createElement('a')
  link.hidden = true
  link.style.lineHeight = 'normal'
  link.contentEditable = 'false'
  link.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const source = getSource()
    if (source) {
      openAppHttpLink(source, { event })
    }
  })
  image.addEventListener('error', () => {
    const source = getSource()
    if (!source) {
      return
    }
    link.href = source
    link.textContent = image.alt || source
    image.hidden = true
    link.hidden = false
  })
  const reset = (): void => {
    image.hidden = false
    link.hidden = true
  }
  image.addEventListener('load', reset)
  container.appendChild(link)
  return {
    update: (sourceChanged) => {
      if (sourceChanged) {
        reset()
      } else if (!link.hidden) {
        link.textContent = image.alt || getSource() || ''
      }
    }
  }
}
