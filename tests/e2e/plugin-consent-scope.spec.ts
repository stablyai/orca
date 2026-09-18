import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS } from '../../src/shared/plugins/plugin-read-confinement'
import { expect, test } from './helpers/orca-app'

const NARROW_SCOPE = ['src/**/*.ts']
const BLOCKED_SCOPE = [...PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS]

type FixtureOptions = {
  scope?: string[]
  deferDecision?: boolean
  marketplaceInstalled?: boolean
}

async function installConsentFixtures(
  app: ElectronApplication,
  page: Page,
  options: FixtureOptions = {}
): Promise<void> {
  const scope = options.scope ?? NARROW_SCOPE
  await app.evaluate(
    ({ ipcMain }, { scope, deferDecision, marketplaceInstalled }) => {
      const installed = {
        pluginKey: 'example.scope-reader',
        consentFingerprint: 'scope-consent-fingerprint',
        name: 'Scope Reader',
        version: '1.0.0',
        publisher: 'example',
        description: 'Reads only reviewed files.',
        status: 'pending' as const,
        needsReconsent: false,
        isDev: false,
        official: false,
        bundled: false,
        capabilities: [
          {
            kind: 'files:read' as const,
            paths: scope,
            description: 'Read files in your worktrees'
          }
        ],
        panels: [],
        commands: [],
        hasWorker: false,
        restarts: 0,
        source: { kind: 'local-path' as const, reference: '/fixture/scope-reader' }
      }
      const source = {
        id: 'a'.repeat(32),
        source: {
          kind: 'git' as const,
          url: 'https://example.invalid/marketplace.git',
          ref: 'main'
        },
        addedAt: 1,
        marketplace: {
          name: 'Consent Fixtures',
          owner: 'example',
          resolvedCommit: 'b'.repeat(40),
          fetchedAt: 2
        },
        stale: false,
        official: false
      }
      const listing = {
        marketplaceSourceId: source.id,
        marketplaceName: source.marketplace.name,
        marketplaceOwner: source.marketplace.owner,
        marketplaceCommit: source.marketplace.resolvedCommit,
        pluginKey: 'example.market-reader',
        source: { kind: 'git' as const, url: 'https://example.invalid/reader.git', ref: 'v1' },
        description: 'Marketplace scope fixture.',
        categories: ['testing'],
        official: false,
        bundled: false
      }
      const preview = {
        ...listing,
        resolvedCommit: 'c'.repeat(40),
        contentHash: 'scope-content-hash',
        consentFingerprint: 'market-consent-fingerprint',
        manifest: {
          manifestVersion: 1 as const,
          id: 'market-reader',
          publisher: 'example',
          name: 'Marketplace Scope Reader',
          version: '1.0.0',
          description: 'Marketplace scope fixture.',
          engines: { orca: '>=1.0.0' },
          pluginApi: 1,
          contributes: {
            panels: [],
            commands: [],
            events: [],
            languagePacks: [],
            keybindings: [],
            vmRecipes: [],
            agents: []
          },
          capabilities: [{ kind: 'files:read' as const, paths: scope }]
        }
      }

      const listed = marketplaceInstalled
        ? [
            installed,
            {
              ...installed,
              pluginKey: listing.pluginKey,
              name: preview.manifest.name,
              source: {
                kind: 'marketplace' as const,
                reference: listing.source.url,
                resolvedCommit: preview.resolvedCommit,
                contentHash: 'older-content'
              }
            }
          ]
        : [installed]
      let resolveDecision = (): void => {}
      const decisionGate = deferDecision
        ? new Promise<void>((resolve) => {
            resolveDecision = resolve
          })
        : Promise.resolve()
      ;(
        globalThis as typeof globalThis & { resolvePluginConsentFixtureDecision?: () => void }
      ).resolvePluginConsentFixtureDecision = resolveDecision
      const afterDecision = async <T>(value: T): Promise<T> => {
        await decisionGate
        return value
      }

      const handlers = {
        'plugins:list': () => listed,
        'plugins:refresh': () => listed,
        'plugins:consent': () => afterDecision([]),
        'plugins:listMarketplaces': () => [source],
        'plugins:listMarketplacePlugins': () => [listing],
        'plugins:previewMarketplacePlugin': () => preview,
        'plugins:previewMarketplaceUpdate': () => preview,
        'plugins:installMarketplacePlugin': () =>
          afterDecision({
            ok: true as const,
            pluginKey: listing.pluginKey,
            version: preview.manifest.version,
            contentHash: preview.contentHash,
            consentFingerprint: preview.consentFingerprint,
            resolvedCommit: preview.resolvedCommit
          })
      }
      for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
    },
    {
      scope,
      deferDecision: options.deferDecision ?? false,
      marketplaceInstalled: options.marketplaceInstalled ?? false
    }
  )
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true })
    window.__store?.setState({ settings })
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'plugins', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function resolveConsentFixtureDecision(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const fixtureGlobal = globalThis as typeof globalThis & {
      resolvePluginConsentFixtureDecision?: () => void
    }
    fixtureGlobal.resolvePluginConsentFixtureDecision?.()
    delete fixtureGlobal.resolvePluginConsentFixtureDecision
  })
}

type RectSnapshot = Record<
  'x' | 'y' | 'width' | 'height' | 'top' | 'right' | 'bottom' | 'left',
  number
>

async function consentGeometry(dialog: ReturnType<Page['getByRole']>): Promise<{
  scope: RectSnapshot
  footer: RectSnapshot
}> {
  return dialog.evaluate((element) => {
    const scope = element.querySelector('ul[aria-label="File patterns"]')
    const footer = element.querySelector('[data-slot="dialog-footer"]')
    if (!scope || !footer) {
      throw new Error('consent scope or footer unavailable')
    }
    return {
      scope: scope.getBoundingClientRect().toJSON(),
      footer: footer.getBoundingClientRect().toJSON()
    }
  })
}

async function expectBoundedDialog(dialog: ReturnType<Page['getByRole']>): Promise<void> {
  const geometry = await dialog.evaluate((element) => {
    const footer = element.querySelector('[data-slot="dialog-footer"]')
    const box = element.getBoundingClientRect()
    const footerBox = footer?.getBoundingClientRect()
    return {
      dialogLeft: box.left,
      dialogRight: box.right,
      viewportWidth: document.documentElement.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogOverflow: element.scrollWidth - element.clientWidth,
      footerTop: footerBox?.top ?? -1,
      footerBottom: footerBox?.bottom ?? -1,
      overflowX: getComputedStyle(element).overflowX,
      overflowY: getComputedStyle(element).overflowY
    }
  })
  expect(geometry.dialogLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
  expect(geometry.dialogOverflow).toBeLessThanOrEqual(1)
  expect(geometry.overflowX).not.toBe('scroll')
  expect(geometry.overflowY).toBe('auto')
  await dialog.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeVisible()
}

function exactList(
  dialog: ReturnType<Page['getByRole']>,
  name: string
): ReturnType<Page['locator']> {
  return dialog.getByRole('list', { name }).locator('li')
}

async function expectExactScope(
  dialog: ReturnType<Page['getByRole']>,
  scopeName: string,
  scope: readonly string[]
): Promise<void> {
  await expect(exactList(dialog, scopeName)).toHaveText(scope)
  await expect(exactList(dialog, 'Always blocked')).toHaveText(BLOCKED_SCOPE)
}

test('renders the same narrow grant and keyboard outcomes in both consent dialogs', async ({
  electronApp,
  orcaPage
}) => {
  await installConsentFixtures(electronApp, orcaPage)

  await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
  const installedRow = orcaPage.locator('[data-plugin-key="example.scope-reader"]')
  await installedRow.getByRole('button', { name: 'Review & enable' }).click()
  const installedDialog = orcaPage.getByRole('dialog', { name: 'Review permissions' })
  await expect(installedDialog).toBeVisible()
  await expectExactScope(installedDialog, 'File patterns', NARROW_SCOPE)
  const keepDisabled = installedDialog.getByRole('button', { name: 'Keep Disabled' })
  await expect(keepDisabled).toBeFocused()
  await orcaPage.keyboard.press('Tab')
  await expect(installedDialog.getByRole('button', { name: 'Enable plugin' })).toBeFocused()
  await orcaPage.keyboard.press('Escape')
  await expect(installedDialog).toBeHidden()

  await orcaPage.getByRole('tab', { name: /^All/ }).click()
  const marketplaceRow = orcaPage.locator('[data-marketplace-plugin-key="example.market-reader"]')
  await marketplaceRow.getByRole('button', { name: 'Install' }).click()
  const marketplaceDialog = orcaPage.getByRole('dialog', { name: 'Marketplace Scope Reader' })
  await expect(marketplaceDialog).toBeVisible()
  await expectExactScope(marketplaceDialog, 'File patterns', NARROW_SCOPE)
  await expect(marketplaceDialog.locator(':focus')).toHaveCount(1)
  await orcaPage.keyboard.press('Escape')
  await expect(marketplaceDialog).toBeHidden()
  await expect(marketplaceRow.getByRole('button', { name: 'Install' })).toBeEnabled()
})

test('keeps maximum scope inside host security chrome at narrow width and 200% zoom', async ({
  electronApp,
  orcaPage
}) => {
  const maximumScope = Array.from({ length: 32 }, (_, index) => {
    const prefix = `scope-${String(index).padStart(2, '0')}/`
    return `${prefix}${'a'.repeat(256 - prefix.length)}`
  })
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(320, 760)
  )
  await installConsentFixtures(electronApp, orcaPage, { scope: maximumScope })
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ theme: 'dark' })
    document.documentElement.style.setProperty('--background', 'rgb(255 0 0)')
  })
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)

  await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
  await orcaPage
    .locator('[data-plugin-key="example.scope-reader"]')
    .getByRole('button', { name: 'Review & enable' })
    .click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Review permissions' })
  await expect(exactList(dialog, 'File patterns')).toHaveText(maximumScope)
  await expectBoundedDialog(dialog)
  const securityTokens = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.getPropertyValue('--background').trim(),
      hostBackground: style.getPropertyValue('--orca-security-background').trim()
    }
  })
  expect(securityTokens.background).toBe(securityTokens.hostBackground)
  expect(securityTokens.background).not.toBe('rgb(255 0 0)')

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
  })
  await expectBoundedDialog(dialog)
})

test('renders whole-worktree companions and update-specific cancellation in light mode', async ({
  electronApp,
  orcaPage
}) => {
  const scope = ['**', 'src/**/*.ts', 'docs/**']
  await installConsentFixtures(electronApp, orcaPage, { scope, marketplaceInstalled: true })
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ theme: 'light' })
  })
  await expect(orcaPage.locator('html')).not.toHaveClass(/dark/)
  const row = orcaPage.locator('[data-marketplace-plugin-key="example.market-reader"]')
  await row.getByRole('button', { name: 'Check for update' }).click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Marketplace Scope Reader' })
  await expectExactScope(dialog, 'Whole worktree', scope)
  await expect(dialog.getByText('throughout each worktree')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel update' })).toBeVisible()
  await expectBoundedDialog(dialog)
})

test('locks both decisions immediately without focus or geometry drift while pending', async ({
  electronApp,
  orcaPage
}) => {
  await installConsentFixtures(electronApp, orcaPage, { deferDecision: true })
  await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
  await orcaPage
    .locator('[data-plugin-key="example.scope-reader"]')
    .getByRole('button', { name: 'Review & enable' })
    .click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Review permissions' })
  await dialog.evaluate(async (element) => {
    await document.fonts.ready
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {}))
    )
  })
  const before = await consentGeometry(dialog)
  const keepDisabled = dialog.getByRole('button', { name: 'Keep Disabled' })
  const enablePlugin = dialog.getByRole('button', { name: 'Enable plugin' })
  await keepDisabled.click()
  try {
    await expect(keepDisabled).toBeDisabled()
    await expect(enablePlugin).toBeDisabled()
    const pending = await consentGeometry(dialog)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeVisible()
    await expect(exactList(dialog, 'File patterns')).toBeVisible()
    await expect(exactList(dialog, 'File patterns')).toHaveText(NARROW_SCOPE)
    await expect(dialog.locator(':focus')).toHaveCount(0)
    await expect(orcaPage.locator('body')).toBeFocused()
    const geometryKeys = ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'] as const
    const largestGeometryDelta = Math.max(
      ...(['scope', 'footer'] as const).flatMap((region) =>
        geometryKeys.map((key) => Math.abs(pending[region][key] - before[region][key]))
      )
    )
    expect(largestGeometryDelta).toBeLessThanOrEqual(1)
    await resolveConsentFixtureDecision(electronApp)
    await expect(dialog).toBeHidden()
  } finally {
    await resolveConsentFixtureDecision(electronApp)
  }
})
