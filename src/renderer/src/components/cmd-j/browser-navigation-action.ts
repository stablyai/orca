import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  classifyExplicitUrl,
  classifyHostUrl
} from '@/components/tab-bar/tab-create-entry-url-classification'
import { isCmdJPaletteQueryTooLarge } from './palette-results'
import { getBrowserWorkspaceActionAvailability } from './quick-action-context'
import { runBrowserWorkspaceAction, type CmdJQuickAction } from './quick-actions'

export const BROWSER_NAVIGATION_ACTION_ID = 'navigate-to-url'

export function buildCmdJBrowserNavigationAction(query: string): CmdJQuickAction | null {
  const input = query.trim()
  if (!input || isCmdJPaletteQueryTooLarge(input)) {
    return null
  }
  // Why listed domains only: Cmd+J has no file rows to outrank a dotted name such as `App.vue`.
  const target = classifyExplicitUrl(input) ?? classifyHostUrl(input, { requireListedDomain: true })
  if (!target || target.kind === 'blocked') {
    return null
  }
  return {
    id: BROWSER_NAVIGATION_ACTION_ID,
    kind: 'action',
    title: translate('worktreeJumpPalette.goToWebsite', 'Go to {{value0}}', { value0: input }),
    description: translate('worktreeJumpPalette.openWebsiteInNewTab', 'Open in a new browser tab'),
    icon: Globe,
    verbKeywords: [],
    sourceQuery: input,
    isAvailable: getBrowserWorkspaceActionAvailability,
    run: (context) =>
      runBrowserWorkspaceAction(context, (groupId) => context.openBrowserUrl(groupId, target.url))
  }
}
