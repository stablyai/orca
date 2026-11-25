import { SIDEBAR_PROJECTS_MIN_LIST_HEIGHT } from '../../../../shared/sidebar-bots-height'

const PROJECTS = ':scope > [data-sidebar-project-workspaces]'
export const PROJECTS_CONTENT_MIN_HEIGHT = '--sidebar-projects-content-min-height'

export function measureSidebarProjectsContent(slot: HTMLElement) {
  const projects = slot.querySelector<HTMLElement>(PROJECTS)
  if (!projects) {
    return null
  }
  const viewport = projects.querySelector<HTMLElement>(
    '[data-sidebar-workspace-section="projects"]'
  )
  const scroller = viewport?.firstElementChild
  const minimum = viewport ? Number.parseFloat(getComputedStyle(viewport).minHeight) : 0
  const projectHeight =
    getComputedStyle(projects).display === 'none'
      ? 0
      : minimum ||
        Math.min(
          scroller instanceof HTMLElement ? scroller.scrollHeight : projects.scrollHeight,
          SIDEBAR_PROJECTS_MIN_LIST_HEIGHT
        )
  const otherHeight = [...slot.children].reduce((height, child) => {
    if (!(child instanceof HTMLElement) || child === projects) {
      return height
    }
    const style = getComputedStyle(child)
    return (
      height +
      child.offsetHeight +
      (Number.parseFloat(style.marginTop) || 0) +
      (Number.parseFloat(style.marginBottom) || 0)
    )
  }, 0)
  return { minimumHeight: Math.ceil(projectHeight + otherHeight), otherHeight }
}

export function observeSidebarProjectsContent(slot: HTMLElement): () => void {
  const measure = () => {
    const size = measureSidebarProjectsContent(slot)
    if (size) {
      const height = `${size.minimumHeight}px`
      if (slot.style.getPropertyValue(PROJECTS_CONTENT_MIN_HEIGHT) !== height) {
        slot.style.setProperty(PROJECTS_CONTENT_MIN_HEIGHT, height)
      }
    }
  }
  const resize = new ResizeObserver(measure)
  const observeChildren = () => {
    resize.disconnect()
    for (const child of slot.children) {
      if (child instanceof HTMLElement) {
        resize.observe(child)
      }
    }
    measure()
  }
  const mutation = new MutationObserver(observeChildren)
  mutation.observe(slot, { childList: true })
  observeChildren()
  return () => {
    resize.disconnect()
    mutation.disconnect()
    slot.style.removeProperty(PROJECTS_CONTENT_MIN_HEIGHT)
  }
}
