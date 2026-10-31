import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { SettingsNavTarget } from '../../../src/renderer/src/lib/settings-navigation-types'
import { getProjectGroupingModelFromState } from '../../../src/renderer/src/store/project-host-setup-selector'
import {
  buildSettingsProjectList,
  buildRepoIdToRepresentative,
  buildRepoIdToHostSelection
} from '../../../src/renderer/src/components/settings/settings-project-list'
import { getSettingsSectionId } from '../../../src/renderer/src/components/settings/settings-navigation-foundations'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'

/**
 * Opens Settings and shows each pane in turn, waiting until it has mounted (only the active pane
 * mounts, so its reads run only then), then closes Settings. `repoId` adds that project's pane.
 */
export async function visitSettingsPanes(
  page: Page,
  panes: readonly SettingsNavTarget[],
  repoId: string | null = null
): Promise<void> {
  const snapshot = await page.evaluate(() => {
    const state = window.__store!.getState()
    return {
      repos: state.repos,
      projects: state.projects,
      projectHostSetups: state.projectHostSetups,
      settings: state.settings
    }
  })
  const projects = buildSettingsProjectList(
    snapshot.repos,
    getProjectGroupingModelFromState(snapshot)
  )
  const representative = buildRepoIdToRepresentative(projects)
  const selected = repoId ? buildRepoIdToHostSelection(projects).get(repoId) : undefined
  const repo = selected
    ? snapshot.repos.find(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === selected.hostId
      )
    : undefined
  if (repoId && (!selected || !repo)) {
    throw new Error(`Missing exact Settings setup for ${repoId}`)
  }
  const targets = [
    ...panes.map((pane) => ({ pane, sectionId: getSettingsSectionId(pane, null, representative) })),
    ...(repoId
      ? [{ pane: 'repo' as const, sectionId: getSettingsSectionId('repo', repoId, representative) }]
      : [])
  ]
  for (const { pane, sectionId } of targets) {
    await page.evaluate(
      ({ pane, repoId, hostId }) => {
        const state = window.__store?.getState()
        state?.openSettingsTarget({
          pane,
          repoId: pane === 'repo' ? repoId : null,
          ...(pane === 'repo' && hostId ? { hostId } : {})
        })
        state?.openSettingsPage()
      },
      { pane, repoId, hostId: selected?.hostId }
    )
    const section = page.locator(`section[data-settings-section=${JSON.stringify(sectionId)}]`)
    await expect(section).toBeVisible({ timeout: 30_000 })
    if (pane === 'repo' && selected && repo) {
      await expect
        .poll(() =>
          page.evaluate((selectionKey) => {
            const state = window.__store!.getState()
            return {
              hostId: state.settingsProjectHostSelection[selectionKey],
              setupId: state.settingsProjectSetupSelection[selectionKey]
            }
          }, selected.selectionKey)
        )
        .toEqual({ hostId: selected.hostId, setupId: selected.setupId })
      await expect(
        section.locator(`input[id=${JSON.stringify(`repo-display-name-${repo.id}`)}]`)
      ).toHaveValue(repo.displayName)
      await expect(section).toContainText(repo.path)
    }
  }
  await page.evaluate(() => window.__store?.getState().closeSettingsPage())
}
