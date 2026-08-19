import type React from 'react'
import type { CSSProperties } from 'react'
import { CalendarClock, GitBranch, List, PanelLeft, Smartphone, TerminalSquare } from 'lucide-react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { Card } from '@/components/ui/card'
import {
  getAppearancePreviewBackgroundStyle,
  useAppearancePreviewBackground
} from './appearance-preview-background'
import type { LoadedAppearancePreviewBackground } from './appearance-preview-background'

type AppearanceChromeMockProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  statusBarItems: readonly StatusBarItem[]
}

type PreviewNavItem = {
  id: string
  label: string
  icon: typeof List
}

const SYSTEM_STATUS_ITEMS = new Set<StatusBarItem>(['ssh', 'resource-usage', 'ports'])

function isPreviewNavItemVisible(value: boolean | undefined): boolean {
  return value !== false
}

function AppearancePreviewBackgroundLayer({
  area,
  background
}: {
  area: 'left-sidebar' | 'right-sidebar'
  background: LoadedAppearancePreviewBackground | null
}): React.JSX.Element | null {
  if (!background) {
    return null
  }
  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-appearance-preview-background={area}
      data-background-file-name={background.fileName}
      style={getAppearancePreviewBackgroundStyle(background)}
      aria-hidden="true"
    />
  )
}

function statusBarItemLabel(item: StatusBarItem): string {
  switch (item) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'gemini':
      return 'Gemini'
    case 'antigravity':
      return 'Antigravity'
    case 'opencode-go':
      return 'OpenCode Go'
    case 'kimi':
      return 'Kimi'
    case 'minimax':
      return 'MiniMax'
    case 'grok':
      return 'Grok'
    case 'ssh':
      return translate('auto.components.settings.AppearanceChromeMock.ssh', 'SSH')
    case 'resource-usage':
      return translate(
        'auto.components.settings.AppearanceChromeMock.resourceUsage',
        'Resource usage'
      )
    case 'ports':
      return translate('auto.components.settings.AppearanceChromeMock.ports', 'Ports')
  }
}

export function AppearanceChromeMock({
  settings,
  systemPrefersDark,
  statusBarItems
}: AppearanceChromeMockProps): React.JSX.Element {
  const leftSidebarStyle = resolveLeftSidebarStyleVariables(settings, systemPrefersDark) as
    | CSSProperties
    | undefined
  const leftSidebarBackground = useAppearancePreviewBackground(settings, 'leftSidebar')
  const rightSidebarBackground = useAppearancePreviewBackground(settings, 'rightSidebar')
  const appFontStyle = {
    '--app-font-family': buildAppFontFamily(settings.appFontFamily),
    fontFamily: 'var(--app-font-family)'
  } as CSSProperties
  const cardLayout = settings.compactWorktreeCards ? 'compact' : 'detailed'
  const navItems: PreviewNavItem[] = [
    ...(isPreviewNavItemVisible(settings.showTasksButton)
      ? [
          {
            id: 'tasks',
            label: translate('auto.components.settings.AppearanceChromeMock.tasks', 'Tasks'),
            icon: List
          }
        ]
      : []),
    ...(isPreviewNavItemVisible(settings.showAutomationsButton)
      ? [
          {
            id: 'automations',
            label: translate(
              'auto.components.settings.AppearanceChromeMock.automations',
              'Automations'
            ),
            icon: CalendarClock
          }
        ]
      : []),
    ...(isPreviewNavItemVisible(settings.showMobileButton)
      ? [
          {
            id: 'mobile',
            label: translate('auto.components.settings.AppearanceChromeMock.mobile', 'Mobile'),
            icon: Smartphone
          }
        ]
      : [])
  ]
  const statusSummary = statusBarItems.map(statusBarItemLabel).join(', ')
  const previewLabel = statusSummary
    ? translate(
        'auto.components.settings.AppearanceChromeMock.previewLabelWithStatus',
        'Orca interface preview. Status bar: {{value0}}',
        { value0: statusSummary }
      )
    : translate(
        'auto.components.settings.AppearanceChromeMock.previewLabel',
        'Orca interface preview'
      )

  return (
    <Card
      className="gap-0 overflow-hidden py-0"
      style={appFontStyle}
      role="img"
      aria-label={previewLabel}
    >
      <div
        className="flex h-8 items-center gap-2 border-b border-border/50 bg-[var(--bg-titlebar,var(--card))] px-3"
        data-titlebar-app-name-visible={settings.showTitlebarAppName}
      >
        <PanelLeft className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {settings.showTitlebarAppName ? (
          <span className="text-xs font-medium">{translate('auto.App.5096cbbc86', 'Orca')}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1" aria-hidden="true">
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        </div>
      </div>

      <div className="flex h-60 min-h-0">
        <div
          className="relative isolate flex w-32 shrink-0 flex-col overflow-hidden border-r border-worktree-sidebar-border bg-worktree-sidebar text-worktree-sidebar-foreground"
          style={leftSidebarStyle}
          data-preview-area="left-sidebar"
          data-left-sidebar-appearance={settings.leftSidebarAppearanceMode}
        >
          <AppearancePreviewBackgroundLayer
            area="left-sidebar"
            background={leftSidebarBackground}
          />
          {navItems.length > 0 ? (
            <div className="relative z-10 space-y-0.5 border-b border-worktree-sidebar-border p-2">
              {navItems.map((item) => {
                const Icon = item.icon
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-worktree-sidebar-foreground/60"
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </div>
                )
              })}
            </div>
          ) : null}

          <div className="relative z-10 min-h-0 flex-1 p-2">
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-worktree-sidebar-foreground/60">
              {translate('auto.components.settings.AppearanceChromeMock.projects', 'Projects')}
            </p>
            <div
              className="rounded-lg border border-worktree-sidebar-border bg-worktree-sidebar-accent px-2.5 py-2 text-worktree-sidebar-accent-foreground"
              data-workspace-card-layout={cardLayout}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-worktree-sidebar-foreground/50" />
                <span className="truncate text-xs font-medium">
                  {translate(
                    'auto.components.settings.AppearanceChromeMock.workspace',
                    'appearance-preview'
                  )}
                </span>
              </div>
              {cardLayout === 'detailed' ? (
                <div className="mt-2 space-y-1 text-[11px] text-worktree-sidebar-foreground/60">
                  <div className="flex items-center gap-1.5">
                    <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {translate(
                        'auto.components.settings.AppearanceChromeMock.branchName',
                        'feature/preview'
                      )}
                    </span>
                  </div>
                  <p className="truncate pl-4.5">
                    {translate(
                      'auto.components.settings.AppearanceChromeMock.terminalCount',
                      '1 terminal'
                    )}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          <div className="flex h-8 items-center gap-2 border-b border-border/50 px-3 text-xs text-muted-foreground">
            <TerminalSquare className="size-3.5" aria-hidden="true" />
            <span className="truncate">
              {translate('auto.components.settings.AppearanceChromeMock.editorPath', 'src/App.tsx')}
            </span>
          </div>
          <div className="min-h-0 flex-1 bg-[var(--editor-surface)] p-3" aria-hidden="true">
            <div className="space-y-2 font-mono">
              <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/30" />
              <div className="ml-3 h-1.5 w-1/2 rounded-full bg-muted-foreground/20" />
              <div className="ml-3 h-1.5 w-2/3 rounded-full bg-muted-foreground/20" />
              <div className="h-1.5 w-1/3 rounded-full bg-muted-foreground/30" />
              <div className="mt-4 h-1.5 w-4/5 rounded-full bg-muted-foreground/20" />
              <div className="ml-3 h-1.5 w-3/5 rounded-full bg-muted-foreground/20" />
            </div>
          </div>
        </div>

        <div
          className="relative isolate flex w-20 shrink-0 flex-col overflow-hidden border-l border-border/50 bg-background text-foreground"
          data-preview-area="right-sidebar"
        >
          <AppearancePreviewBackgroundLayer
            area="right-sidebar"
            background={rightSidebarBackground}
          />
          <div className="relative z-10 flex h-8 items-center gap-1.5 border-b border-border/50 px-2 text-[11px] text-muted-foreground">
            <List className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {translate('auto.components.settings.AppearanceChromeMock.explorer', 'Explorer')}
            </span>
          </div>
          <div className="relative z-10 min-h-0 flex-1 space-y-2 p-2" aria-hidden="true">
            <div className="h-1.5 w-4/5 rounded-full bg-muted-foreground/30" />
            <div className="ml-2 h-1.5 w-3/5 rounded-full bg-muted-foreground/20" />
            <div className="ml-2 h-1.5 w-3/4 rounded-full bg-muted-foreground/20" />
            <div className="h-1.5 w-2/3 rounded-full bg-muted-foreground/30" />
          </div>
        </div>
      </div>

      <div className="flex h-6 items-center gap-2 border-t border-border bg-[var(--bg-titlebar,var(--card))] px-3 text-[11px] text-muted-foreground">
        <GitBranch className="size-3" aria-hidden="true" />
        <span>{translate('auto.components.settings.AppearanceChromeMock.baseBranch', 'main')}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1" aria-hidden="true">
          {statusBarItems.map((item) => (
            <span
              key={item}
              data-status-bar-item={item}
              className={`h-1.5 rounded-full bg-muted-foreground/50 ${
                SYSTEM_STATUS_ITEMS.has(item) ? 'w-3' : 'w-1'
              }`}
            />
          ))}
        </div>
      </div>
    </Card>
  )
}
