import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { SidebarBody } from '../../../../../shared/ui-chrome/sidebar-body'

/** Each sidebar body's name, shared by its header and Settings; upstream's list keeps its grouping title. */
export function useSidebarBodyTitles(): Record<SidebarBody, string> {
  const t = useTranslate()
  const groupedByProject = useAppStore((s) => s.groupBy === 'repo')
  return {
    workspaces: groupedByProject
      ? t('dashboard.sidebar.projects', 'Projects')
      : t('dashboard.sidebar.workspaces', 'Workspaces'),
    conversations: t('dashboard.sidebar.sessions', 'Sessions'),
    agents: t('dashboard.sidebar.activity', 'Activity')
  }
}
