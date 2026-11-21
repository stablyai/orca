import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'

/** Turns on the plugin system with these dev folders and approves each plugin's review. */
export async function enableDevPlugins(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(async (devPluginPaths) => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true, devPluginPaths })
    window.__store?.setState({ settings })
    for (const plugin of await window.api.plugins.refresh()) {
      if (plugin.isDev && plugin.status === 'pending' && plugin.consentFingerprint) {
        await window.api.plugins.consent({
          pluginKey: plugin.pluginKey,
          reviewedFingerprint: plugin.consentFingerprint,
          decision: 'approve'
        })
      }
    }
  }, paths)
}

export async function disablePluginSystem(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({
      pluginSystemEnabled: false,
      devPluginPaths: []
    })
    window.__store?.setState({ settings })
    await window.api.plugins.refresh()
  })
}

export async function openRepoFile(page: Page, repoPath: string, name: string): Promise<void> {
  await page.evaluate(
    ({ name, filePath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('no active worktree')
      }
      state.openFile({
        filePath,
        relativePath: name,
        worktreeId: state.activeWorktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { name, filePath: join(repoPath, name) }
  )
}

/** Distinct Monaco token classes painted on lines containing `text`, or on every line. */
export function editorTokenClasses(page: Page, text = ''): Promise<string[]> {
  return page.evaluate((needle) => {
    const classes = new Set<string>()
    for (const line of document.querySelectorAll('.monaco-editor .view-lines .view-line')) {
      if (line.textContent?.replaceAll(' ', ' ').includes(needle)) {
        for (const span of line.querySelectorAll('span span')) {
          for (const name of span.classList) {
            if (name.startsWith('mtk')) {
              classes.add(name)
            }
          }
        }
      }
    }
    return [...classes].sort()
  }, text)
}

/** The computed color of the first painted token whose text is exactly `text`. */
export function editorTokenColor(page: Page, text: string): Promise<string | null> {
  return page.evaluate((needle) => {
    for (const span of document.querySelectorAll(
      '.monaco-editor .view-lines .view-line span span'
    )) {
      if (span.textContent?.replaceAll(' ', ' ').trim() === needle) {
        return getComputedStyle(span).color
      }
    }
    return null
  }, text)
}
