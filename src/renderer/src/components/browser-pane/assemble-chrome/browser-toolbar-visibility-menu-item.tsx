import { PanelTopClose, PanelTopOpen } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser-page-records'
import { translate } from '@/i18n/i18n'

export function BrowserToolbarVisibilityMenuItem({
  browserPageId,
  menuKind
}: {
  browserPageId: string | null | undefined
  menuKind: 'context' | 'dropdown'
}): React.JSX.Element | null {
  const visibility = useAppStore((s) => {
    const page = browserPageId ? findPage(s.browserPagesByWorkspace, browserPageId) : null
    return !page || page.docLocation ? null : page.chromeless === true
  })
  const setChromeless = useAppStore((s) => s.setBrowserPageChromeless)
  if (visibility === null || !browserPageId) {
    return null
  }
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Icon = visibility ? PanelTopOpen : PanelTopClose
  return (
    <Item onSelect={() => setChromeless(browserPageId, !visibility)}>
      <Icon className="size-4" />
      {visibility
        ? translate('browser.toolbar.show', 'Show Browser Toolbar')
        : translate('browser.toolbar.hide', 'Hide Browser Toolbar')}
    </Item>
  )
}
