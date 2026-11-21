import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { BuiltInUiLanguage } from '../../../../shared/i18n/ui-language'
import type { SidebarView } from '../../../../shared/ui-chrome/sidebar-body'
import SidebarHeader from './chrome/SidebarHeader'

// Presses the title where a pointer would land, so a fold button drawn over it keeps the menu shut.
async function openViewMenu(frame: HTMLElement): Promise<void> {
  const trigger = frame.querySelector<HTMLElement>('[data-sidebar-section-title]')
  const box = trigger?.getBoundingClientRect()
  const target =
    box && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  target?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
  )
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

function header(view: SidebarView, options: { menu?: boolean; language?: BuiltInUiLanguage } = {}) {
  return defineFixture({
    width: 280,
    store: {
      settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: options.language ?? 'en' },
      sidebarView: view,
      sidebarBody: view
    },
    interact: options.menu ? openViewMenu : undefined,
    // Collapsible, as beside Bots in the app, so the fold button spans the header.
    render: () => <SidebarHeader collapsible onWorkspaceBoardMenuOpenChange={() => undefined} />
  })
}

export const Projects = header('workspaces')
export const Sessions = header('conversations')
export const ProjectsViewMenu = header('workspaces', { menu: true })
export const SessionsViewMenu = header('conversations', { menu: true })
export const SessionsViewMenuRussian = header('conversations', { menu: true, language: 'ru' })
