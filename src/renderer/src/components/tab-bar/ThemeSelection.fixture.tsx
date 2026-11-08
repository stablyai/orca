import { Files, GitBranch, LayoutGrid } from 'lucide-react'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../sidebar/workspace-card/surface/WorktreeCard'
import type React from 'react'
import type { AppState } from '../../store/types'
import type { CSSProperties } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { TooltipProvider } from '../ui/tooltip'
import { ActivityBarButton } from '../right-sidebar/activity-bar-buttons'
import { ACTIVE_TAB_INDICATOR_CLASSES, getTabRootStateClasses } from './drop-indicator'

type ThemeVariables = CSSProperties & Record<`--${string}`, string>

const accentPalette: ThemeVariables = {
  '--radius': '0.625rem',
  '--background': '#222429',
  '--foreground': '#D1D3DA',
  '--card': '#26282D',
  '--muted-foreground': '#A6ABB5',
  '--border': '#3A3E46',
  '--ring': '#4781EE',
  '--accent': '#293F65',
  '--accent-foreground': '#D1D3DA',
  '--tab-active': '#24385B',
  '--tab-active-foreground': '#D1D3DA',
  '--tab-active-indicator': '#759CF0',
  '--tab-inactive': '#26282D',
  '--tab-inactive-foreground': '#A6ABB5',
  '--worktree-sidebar-active': '#24385B',
  '--worktree-sidebar-active-border': '#4781EE',
  '--sidebar': '#222429',
  '--sidebar-foreground': '#D1D3DA',
  '--sidebar-ring': '#4781EE',
  '--sidebar-accent': '#293F65',
  '--sidebar-accent-foreground': '#D1D3DA',
  '--worktree-sidebar': '#222429',
  '--worktree-sidebar-foreground': '#D1D3DA',
  '--worktree-sidebar-border': '#3A3E46',
  '--worktree-sidebar-ring': '#4781EE',
  '--worktree-sidebar-accent': '#293F65',
  '--worktree-sidebar-accent-foreground': '#D1D3DA'
}

const repo = makeRepo()
const activeWorktree = makeWorktree('selection-active', 'main')
const idleWorktree = makeWorktree('selection-idle', 'feature/layout')
const activeTab = {
  ...makeTerminalTab('selection-active-terminal', activeWorktree.id, 'Shell'),
  ptyId: 'selection-active-pty'
}
const idleTab = {
  ...makeTerminalTab('selection-idle-terminal', idleWorktree.id, 'Shell'),
  ptyId: 'selection-idle-pty'
}

function SelectionPreview({ palette }: { palette?: ThemeVariables }): React.JSX.Element {
  return (
    <TooltipProvider>
      <div style={palette} className="bg-background p-4 text-foreground">
        <div className="mb-4 flex items-center justify-between border-b border-border">
          <div className="flex h-10 bg-card">
            <div
              className={`relative flex items-center px-4 text-xs ${getTabRootStateClasses(true)}`}
            >
              Greeting
              <span className={ACTIVE_TAB_INDICATOR_CLASSES} />
            </div>
            <div className={`flex items-center px-4 text-xs ${getTabRootStateClasses(false)}`}>
              main.go
            </div>
          </div>
          <div className="flex bg-sidebar">
            <ActivityBarButton
              item={{ id: 'explorer', icon: Files, title: 'Files', shortcut: '' }}
              active
              onClick={() => {}}
              layout="top"
            />
            <ActivityBarButton
              item={{ id: 'source-control', icon: GitBranch, title: 'Changes', shortcut: '' }}
              active={false}
              onClick={() => {}}
              layout="top"
            />
            <ActivityBarButton
              item={{ id: 'explorer', icon: LayoutGrid, title: 'Files side', shortcut: '' }}
              active
              onClick={() => {}}
              layout="side"
            />
          </div>
        </div>
        <div className="flex gap-4">
          <div className="w-64 bg-worktree-sidebar p-2">
            <div>
              <WorktreeCard
                worktree={activeWorktree}
                repo={repo}
                isActive
                nativeDragEnabled={false}
              />
            </div>
            <div>
              <WorktreeCard
                worktree={idleWorktree}
                repo={repo}
                isActive={false}
                nativeDragEnabled={false}
              />
            </div>
          </div>
          <div className="flex-1 p-3 text-xs text-muted-foreground">
            Accent follows the selected theme. Inactive items stay quiet.
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

const store: Partial<AppState> = {
  settings: { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: true },
  repos: [repo],
  worktreesByRepo: { [repo.id]: [activeWorktree, idleWorktree] },
  worktreeCardProperties: ['branch'],
  tabsByWorktree: { [activeWorktree.id]: [activeTab], [idleWorktree.id]: [idleTab] },
  ptyIdsByTabId: { [activeTab.id]: [activeTab.ptyId], [idleTab.id]: [idleTab.ptyId] }
}

// A plugin theme with accent tokens: the active tool and tab lines take --tab-active-indicator.
export const pluginAccents = defineFixture({
  width: 760,
  store,
  render: () => <SelectionPreview palette={accentPalette} />
})

// Built-in theme: every selection marker stays on the neutral foreground, as before.
export const builtIn = defineFixture({
  width: 760,
  store,
  render: () => <SelectionPreview />
})
