import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 }
]) {
  test(`Turkish language selection, shortcuts and native menus at ${viewport.width}x${viewport.height}`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize(viewport)
    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsTarget({ pane: 'appearance', repoId: null })
      store.getState().openSettingsPage()
    })

    const languagePicker = orcaPage.getByRole('combobox', { name: 'Language', exact: true })
    await expect(languagePicker).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('english-appearance.png') })
    await languagePicker.click()
    await orcaPage.getByRole('option', { name: 'Türkçe', exact: true }).click()
    await expect(orcaPage.getByRole('combobox', { name: 'Dil', exact: true })).toHaveText('Türkçe')
    const globalSearch = orcaPage.getByPlaceholder('Ayarlarda ara', { exact: true })
    await expect(globalSearch).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Kısayollar', exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('turkish-appearance.png') })

    await globalSearch.fill('kısayollar')
    await expect(orcaPage.getByRole('heading', { name: 'Kısayollar', exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Dosyaya Git', { exact: true })).toBeVisible()
    const localSearch = orcaPage.getByPlaceholder('Komut veya tuş ara', { exact: true })
    await localSearch.fill('ileri')
    await expect(orcaPage.getByText('Worktree Geçmişinde İleri', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Tarayıcıda İleri Git', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Dosyaya Git', { exact: true })).not.toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('turkish-forward-search.png') })

    await localSearch.fill('incel')
    await expect(orcaPage.getByText('İnceleme Notu Ekle', { exact: true })).toBeVisible()
    await expect(
      orcaPage.getByText('İnceleme Notlarını Ajana Gönder', { exact: true })
    ).toBeVisible()
    await expect(orcaPage.getByText('Dosyaya Git', { exact: true })).not.toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('turkish-review-search.png') })
    await orcaPage.getByText('İnceleme Notu Ekle', { exact: true }).scrollIntoViewIfNeeded()
    await orcaPage.screenshot({ path: testInfo.outputPath('turkish-review-search-scrolled.png') })

    await localSearch.clear()
    await globalSearch.fill('Dosyaya Git')
    await expect(orcaPage.getByText('Dosyaya Git', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Tarayıcıda İleri Git', { exact: true })).not.toBeVisible()
    const fileShortcut = orcaPage.locator('[data-shortcut-recorder]').filter({ hasText: 'P' })
    await expect(fileShortcut).toHaveCount(1)
    if (process.platform === 'win32') {
      await expect(fileShortcut).toContainText('Ctrl')
      await expect(fileShortcut).not.toContainText('⌘')
    }
    const layout = await orcaPage.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth
    }))
    expect(layout.width).toBe(viewport.width)
    expect(layout.height).toBe(viewport.height)
    expect(layout.scrollWidth).toBeLessThanOrEqual(viewport.width)
    await expect(fileShortcut).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath('turkish-global-shortcut-search.png') })

    const expectedMenus = ['Düzenle', 'Görünüm', 'Pencere', 'Yardım']
    if (process.platform !== 'darwin') {
      expectedMenus.push('Dosya')
    }
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
        )
      )
      .toEqual(expect.arrayContaining(expectedMenus))
    const nativeMenus = await electronApp.evaluate(({ Menu, BrowserWindow }) => ({
      menus: Menu.getApplicationMenu()?.items.map((item) => ({
        label: item.label,
        items: item.submenu?.items.map((child) => ({
          label: child.label,
          accelerator: child.accelerator
        }))
      })),
      visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
    }))
    expect(nativeMenus.visibleWindows).toBe(0)
    const labels = nativeMenus.menus?.flatMap((menu) => menu.items?.map((item) => item.label) ?? [])
    expect(labels).toEqual(
      expect.arrayContaining([
        'Geri Al',
        'Yinele',
        'Kes',
        'Kopyala',
        'Yapıştır',
        'Tümünü Seç',
        'Geliştirici Araçlarını Aç/Kapat',
        'Tam Ekranı Aç/Kapat',
        'Küçült',
        'Büyüt'
      ])
    )
    const menuPath = testInfo.outputPath('turkish-native-menus.json')
    await writeFile(menuPath, JSON.stringify(nativeMenus, null, 2))
    await testInfo.attach('turkish-native-menu-and-window-state', {
      path: menuPath,
      contentType: 'application/json'
    })
  })
}
