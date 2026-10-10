import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ minimumSeededWorktreeCount: 1 })

for (const scenario of ['single', 'children', 'batch', 'known-dirty'] as const) {
  test(`keeps deletion geometry stable while checking ${scenario} workspaces`, async ({
    orcaPage: page,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(page)
    if (scenario === 'batch') {
      await page.emulateMedia({ reducedMotion: 'reduce' })
    }
    await electronApp.evaluate(({ ipcMain }, knownDirty) => {
      ipcMain.removeHandler('git:status')
      ipcMain.handle('git:status', async (_event, args: { worktreePath: string }) => {
        const childIndex = Number(args.worktreePath.match(/child-(\d+)$/)?.[1] ?? 0)
        await new Promise((resolve) => setTimeout(resolve, 1800 + (childIndex % 3) * 180))
        if (
          args.worktreePath.endsWith('child-2') ||
          (knownDirty && args.worktreePath.endsWith('delete-layout-parent'))
        ) {
          throw new Error('Simulated disconnected execution host')
        }
        return {
          entries: args.worktreePath.endsWith('child-1')
            ? []
            : [{ path: 'src/pending-work.ts', status: 'modified', area: 'unstaged' }],
          conflictOperation: 'unknown'
        }
      })
    }, scenario === 'known-dirty')
    await page.evaluate((mode) => {
      const store = window.__store
      const state = store?.getState()
      const repo = state?.repos[0]
      const source = repo && state?.worktreesByRepo[repo.id]?.[0]
      if (!store || !state || !repo || !source) {
        throw new Error('Missing seeded workspace')
      }
      const parent = {
        ...source,
        id: 'delete-layout-parent',
        instanceId: 'delete-layout-parent-instance',
        displayName: 'workspace-with-pending-work',
        path: `${repo.path}/delete-layout-parent`,
        hostId: 'local' as const,
        isMainWorktree: false,
        lineage: null
      }
      const children = Array.from(
        { length: mode === 'children' ? 31 : mode === 'batch' ? 3 : 0 },
        (_, index) => ({
          ...parent,
          id: `delete-layout-child-${index}`,
          instanceId: `delete-layout-child-instance-${index}`,
          displayName: `child-workspace-${index}`,
          path: `${repo.path}/delete-layout-child-${index}`,
          lineage:
            mode === 'children'
              ? {
                  worktreeId: `delete-layout-child-${index}`,
                  worktreeInstanceId: `delete-layout-child-instance-${index}`,
                  parentWorktreeId: parent.id,
                  parentWorktreeInstanceId: parent.instanceId,
                  origin: 'manual' as const,
                  capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
                  createdAt: 1
                }
              : null
        })
      )
      store.setState({
        ...(state.settings
          ? {
              settings: { ...state.settings, theme: mode === 'children' ? 'dark' : 'light' }
            }
          : {}),
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [repo.id]: [...state.worktreesByRepo[repo.id], parent, ...children]
        },
        gitStatusByWorktree: {},
        ...(mode === 'known-dirty'
          ? {
              deleteStateByWorktreeId: {
                [parent.id]: {
                  isDeleting: false,
                  error: null,
                  canForceDelete: true,
                  forceDeleteReason: 'dirty',
                  executionHostId: parent.hostId
                }
              }
            }
          : {})
      })
      state.openModal(
        'delete-worktree',
        mode === 'batch'
          ? { worktreeIds: children.map((child) => child.id), allowSkipConfirm: false }
          : { worktreeId: parent.id, allowSkipConfirm: false }
      )
    }, scenario)
    const dialog = page.getByRole('dialog', { name: /^Delete Workspace/ })
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(250)
    await expect(
      dialog.getByText(scenario === 'known-dirty' ? '· Checking…' : 'Checking for changes…').first()
    ).toBeVisible()
    await expect(dialog.getByText(/will be permanently deleted/)).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('checking.png') })
    await dialog.screenshot({ path: testInfo.outputPath('checking-dialog.png') })
    const frames = await page.evaluate(async () => {
      const samples: {
        dialog: number[]
        button: number[]
        targets: number[]
        confirmFocused: boolean
      }[] = []
      const started = performance.now()
      while (performance.now() - started < 2400) {
        const dialog = document.querySelector('[data-slot="dialog-content"]')
        const button = dialog?.querySelector('[data-slot="dialog-footer"] button:last-child')
        if (!(dialog instanceof HTMLElement) || !(button instanceof HTMLElement)) {
          throw new Error('Missing dialog')
        }
        const bounds = (element: Element): number[] => {
          const rect = element.getBoundingClientRect()
          return [rect.x, rect.y, rect.width, rect.height]
        }
        samples.push({
          dialog: bounds(dialog),
          button: bounds(button),
          confirmFocused: document.activeElement === button,
          targets: Array.from(dialog.querySelectorAll('[role="listitem"], [role="region"], div'))
            .filter(
              (element) =>
                element.matches('[role="listitem"], [role="region"]') ||
                /^child-workspace-\d+$/.test(element.textContent ?? '')
            )
            .flatMap(bounds)
        })
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      return samples
    })
    await expect(
      dialog
        .getByText(
          scenario === 'known-dirty'
            ? 'Uncommitted or untracked changes'
            : '1 uncommitted or untracked change',
          { exact: true }
        )
        .first()
    ).toBeVisible()
    if (scenario === 'known-dirty') {
      await expect(dialog.getByText('· Details unavailable')).toBeVisible()
    } else if (scenario !== 'single') {
      await expect(dialog.getByText('No uncommitted or untracked changes')).toBeVisible()
      await expect(dialog.getByText('Changes could not be checked')).toBeVisible()
    }
    await page.screenshot({ path: testInfo.outputPath('loaded.png') })
    await dialog.screenshot({ path: testInfo.outputPath('loaded-dialog.png') })
    expect(frames.length).toBeGreaterThan(20)
    expect(frames[0]?.confirmFocused).toBe(true)
    for (const frame of frames) {
      expect(frame).toEqual(frames[0])
    }
    if (scenario === 'known-dirty') {
      await expect(dialog.getByRole('button', { name: /Show loaded paths/ })).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden()
      return
    }
    const beforeDetails = await dialog.boundingBox()
    await dialog
      .getByRole('button', { name: /Show loaded paths/ })
      .first()
      .click()
    await expect(page.getByText('src/pending-work.ts', { exact: true })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: testInfo.outputPath('details.png') })
    await dialog.screenshot({ path: testInfo.outputPath('details-dialog.png') })
    expect(await dialog.boundingBox()).toEqual(beforeDetails)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(page.getByText('src/pending-work.ts', { exact: true })).toBeHidden()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
  })
}
