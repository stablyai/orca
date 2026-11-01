import { Files, GitBranch, LayoutGrid } from 'lucide-react'
import { contrastRatio } from '../../lib/plugin-theme-tokens'
import type { CSSProperties } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { TooltipProvider } from '../ui/tooltip'
import { ActivityBarButton } from '../right-sidebar/activity-bar-buttons'
import { ACTIVE_TAB_INDICATOR_CLASSES, getTabRootStateClasses } from './drop-indicator'

interface ThemeVariables extends CSSProperties {
  [key: `--${string}`]: string
}

const palette: ThemeVariables = {
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

export const selected = defineFixture({
  width: 760,
  render: () => (
    <TooltipProvider>
      <div data-selection-fixture style={palette} className="bg-background p-4 text-foreground">
        <div className="mb-4 flex items-center justify-between border-b border-border">
          <div className="flex h-10 bg-card">
            <div
              data-selected-tab
              className={`relative flex items-center px-4 text-xs ${getTabRootStateClasses(true)}`}
            >
              Greeting
              <span data-tab-marker className={ACTIVE_TAB_INDICATOR_CLASSES} />
            </div>
            <div
              data-idle-tab
              className={`flex items-center px-4 text-xs ${getTabRootStateClasses(false)}`}
            >
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
            <div
              data-worktree-card-surface
              data-worktree-card-active="primary"
              className="rounded-lg border p-3 text-xs"
            >
              <div className="font-medium text-foreground" data-selected-title>
                main
              </div>
              <div className="mt-2">Current workspace</div>
            </div>
            <div className="mt-2 rounded-lg border border-transparent p-3 text-xs text-muted-foreground">
              feature/layout
            </div>
          </div>
          <div className="flex-1 p-3 text-xs text-muted-foreground">
            Accent follows the selected theme. Inactive items stay quiet.
          </div>
        </div>
      </div>
    </TooltipProvider>
  ),
  interact: async (frame) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const scope = frame.querySelector('[data-selection-fixture]')
    if (!(scope instanceof HTMLElement)) throw new Error('Missing selection fixture')
    const probe = document.createElement('span')
    scope.append(probe)
    const token = (name: string) => {
      probe.style.color = `var(${name})`
      return getComputedStyle(probe).color
    }
    const marker = scope.querySelector('[data-tab-marker]')
    const tool = scope.querySelector('button[aria-label="Files"]')
    const card = scope.querySelector('[data-worktree-card-active="primary"]')
    if (!marker || getComputedStyle(marker).backgroundColor !== token('--tab-active-indicator'))
      throw new Error('Active tab marker must use its dedicated theme color')
    probe.style.color = 'color-mix(in srgb, var(--sidebar-ring) 20%, var(--sidebar-foreground))'
    if (!tool || getComputedStyle(tool).color !== getComputedStyle(probe).color)
      throw new Error('Active tool icon must blend theme accent with sidebar foreground')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Missing color probe context')
    const color = (value: string): readonly [number, number, number, number] => {
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const surface = color(token('--sidebar'))
    for (const button of scope.querySelectorAll('button[aria-pressed="true"]')) {
      const icon = getComputedStyle(button).color
      const indicator = button.querySelector('div')
      if (contrastRatio(color(icon), surface) < 3)
        throw new Error('Active tool icon must have at least 3:1 sidebar contrast')
      if (!indicator || getComputedStyle(indicator).backgroundColor !== icon)
        throw new Error('Both tool layouts must share the accessible selection color')
    }
    if (!card || getComputedStyle(card).backgroundColor !== token('--worktree-sidebar-active'))
      throw new Error('Current worktree must use its dedicated theme fill')
    probe.remove()
  }
})

export const builtIn = defineFixture({
  ...selected,
  interact: async (frame) => {
    const scope = frame.querySelector('[data-selection-fixture]')
    if (!(scope instanceof HTMLElement)) throw new Error('Missing selection fixture')
    for (const token of ['--sidebar', '--sidebar-foreground', '--sidebar-ring'])
      scope.style.removeProperty(token)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await Promise.all(scope.getAnimations({ subtree: true }).map((animation) => animation.finished))
    await selected.interact?.(frame)
  }
})
