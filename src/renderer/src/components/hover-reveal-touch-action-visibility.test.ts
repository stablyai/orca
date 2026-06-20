import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

// Why: hover-reveal action buttons hide with `opacity-0` and reveal on
// `group-hover`. Touch devices have no hover, so a bare hide leaves the icon
// permanently invisible while the control stays clickable.

const MAIN_CSS = resolve(__dirname, '../assets/main.css')

const HOVER_REVEAL_FILES = [
  resolve(__dirname, 'activity/ActivityPrototypePage.tsx'),
  resolve(__dirname, 'browser-pane/BrowserPane.tsx'),
  resolve(__dirname, 'dashboard/DashboardAgentRow.tsx'),
  resolve(__dirname, 'dashboard/DashboardAgentRowTrailingControls.tsx'),
  resolve(__dirname, 'editor/CombinedDiffViewer.tsx'),
  resolve(__dirname, 'editor/DiffSectionHeader.tsx'),
  resolve(__dirname, 'github-project/ProjectPicker.tsx'),
  resolve(__dirname, 'github-project/ProjectRow.tsx'),
  resolve(__dirname, 'right-sidebar/AiVaultSessionRow.tsx'),
  resolve(__dirname, 'right-sidebar/ChecksPanel.tsx'),
  resolve(__dirname, 'right-sidebar/PortsPanel.tsx'),
  resolve(__dirname, 'right-sidebar/SourceControl.tsx'),
  resolve(__dirname, 'right-sidebar/checks-panel-content.tsx'),
  resolve(__dirname, 'settings/MobilePairingQrSection.tsx'),
  resolve(__dirname, 'settings/ShortcutBindingSubRow.tsx'),
  resolve(__dirname, 'settings/ShortcutCommandBlock.tsx'),
  resolve(__dirname, 'settings/VoiceSpeechModelSection.tsx'),
  resolve(__dirname, 'sidebar/HostSectionHeaderMenu.tsx'),
  resolve(__dirname, 'sidebar/PendingWorktreeRow.tsx'),
  resolve(__dirname, 'sidebar/WorkspaceKanbanStatusLane.tsx'),
  resolve(__dirname, 'sidebar/WorktreeCardPorts.tsx'),
  resolve(__dirname, 'sidebar/WorktreeList.tsx'),
  resolve(__dirname, 'status-bar/ResourceUsageStatusSegment.tsx'),
  resolve(__dirname, 'status-bar/ports-status-popover-rows.tsx'),
  resolve(__dirname, 'tab-bar/TabBarQuickCommandsMenu.tsx')
]

function lineHasBareOpacityZero(line: string): boolean {
  for (const match of line.matchAll(/opacity-0\b/g)) {
    const previousChar = match.index! > 0 ? line[match.index! - 1] : ''
    if (previousChar !== ':') {
      return true
    }
  }

  return false
}

describe('hover-reveal action button touch visibility', () => {
  it('declares the can-hover variant so touch devices skip the hover-only hide', () => {
    const css = readFileSync(MAIN_CSS, 'utf8')
    expect(css).toMatch(/@custom-variant\s+can-hover\s+\(@media\s*\(hover:\s*hover\)\)/)
  })

  it('keeps hover-reveal controls visible on touch devices', () => {
    const offenders: string[] = []

    HOVER_REVEAL_FILES.forEach((file) => {
      const source = readFileSync(file, 'utf8')
      const lines = source.split('\n')

      lines.forEach((line, index) => {
        if (!line.includes('opacity-0') || !lineHasBareOpacityZero(line)) {
          return
        }

        const revealContext = [line, lines[index + 1] ?? '', lines[index + 2] ?? ''].join(' ')
        const isHoverReveal =
          /(group-hover|group-focus-within|focus-visible|focus:|data-\[state=open\]|data-\[selected=true\]):opacity-100/.test(
            revealContext
          )
        const hasTouchOverride = revealContext.includes('[@media(hover:none)]:opacity-100')
        const isPassiveSwap =
          line.includes('[@media(hover:none)]:opacity-0') && line.includes('pointer-events-none')
        const isPointerlessPlaceholder =
          line.includes('pointer-events-none') &&
          !/(group-hover|group-focus-within)/.test(revealContext)

        if (isHoverReveal && !hasTouchOverride && !isPassiveSwap && !isPointerlessPlaceholder) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      })
    })

    expect(offenders).toEqual([])
  })
})
