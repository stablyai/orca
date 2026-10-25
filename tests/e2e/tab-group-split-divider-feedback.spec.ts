import { writeFileSync } from 'node:fs'
import type { Locator } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

async function readDivider(handle: Locator) {
  return handle.evaluate((element) => {
    const style = getComputedStyle(element, '::after')
    const rect = element.getBoundingClientRect()
    const vertical = element.classList.contains('is-vertical')
    const transform = new DOMMatrix(style.transform)
    const thickness = Number.parseFloat(vertical ? style.width : style.height)
    const offset = Number.parseFloat(vertical ? style.left : style.top)
    const translation = vertical ? transform.e : transform.f
    const hitThickness = vertical ? rect.width : rect.height
    const box = (node: Element | null) => {
      const bounds = node?.getBoundingClientRect()
      return bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null
    }
    return {
      thickness,
      hovered: element.matches(':hover'),
      dragging: element.classList.contains('is-dragging'),
      hitThickness,
      centered: Math.abs(offset + translation + thickness / 2 - hitThickness / 2) < 0.01,
      color: style.backgroundColor,
      baseColor: getComputedStyle(document.documentElement)
        .getPropertyValue('--tab-group-split-divider')
        .trim(),
      layout: {
        handle: box(element),
        firstPane: box(element.previousElementSibling),
        secondPane: box(element.nextElementSibling)
      }
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const orientation of ['vertical', 'horizontal'] as const) {
    test(`workspace divider feedback preserves geometry (${theme}, ${orientation})`, async ({
      orcaPage,
      electronApp
    }, testInfo) => {
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused()
          )
        )
      ).toBe(true)
      await orcaPage.evaluate((orientation) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (!state || !worktreeId) {
          throw new Error('No active workspace')
        }
        const sourceGroupId = state.ensureWorktreeRootGroup(worktreeId)
        const groupId = state.createEmptySplitGroup(
          worktreeId,
          sourceGroupId,
          orientation === 'vertical' ? 'right' : 'down'
        )
        if (!groupId) {
          throw new Error('Workspace split creation failed')
        }
        const tab = state.createTab(worktreeId, groupId, undefined, { activate: true })
        state.focusGroup(worktreeId, groupId)
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal', worktreeId)
      }, orientation)
      const handle = orcaPage.locator(`.tab-group-split-resize-handle.is-${orientation}`).first()
      await expect(handle).toBeVisible()
      const colors =
        theme === 'light' ? ['#000000', '#868690', '#171717'] : ['#ffffff', '#71717a', '#cccccc']
      for (const color of colors) {
        await orcaPage.evaluate(
          async ({ theme, color }) => {
            const state = window.__store?.getState()
            if (!state) {
              throw new Error('Store unavailable')
            }
            await state.updateSettingsOrThrow({
              theme,
              tabGroupSplitDividerColorDark: color,
              tabGroupSplitDividerColorLight: color
            })
          },
          { theme, color }
        )
        await expect.poll(async () => (await readDivider(handle)).baseColor).toBe(color)
        await orcaPage.mouse.move(0, 0)
        await expect(handle).not.toHaveClass(/is-dragging/)
        const capture = async (state: string) => {
          const bounds = await handle.boundingBox()
          if (!bounds) {
            throw new Error('Divider missing')
          }
          const viewport = orcaPage.viewportSize() ?? { width: 1200, height: 800 }
          const clip = {
            x: Math.max(0, Math.min(viewport.width - 160, bounds.x + bounds.width / 2 - 80)),
            y: Math.max(0, Math.min(viewport.height - 160, bounds.y + bounds.height / 2 - 80)),
            width: 160,
            height: 160
          }
          const path = testInfo.outputPath(`${color.slice(1)}-${state}.png`)
          await orcaPage.screenshot({ path, clip, animations: 'disabled' })
          await testInfo.attach(`${color}-${state}`, { path, contentType: 'image/png' })
        }
        await capture('idle')
        const idle = await readDivider(handle)
        const samples = [{ state: 'idle', ...idle }]
        await handle.hover()
        await capture('hover')
        const hovered = await readDivider(handle)
        samples.push({ state: 'hover', ...hovered })
        await orcaPage.mouse.down()
        await expect(handle).toHaveClass(/is-dragging/)
        const bounds = await handle.boundingBox()
        if (!bounds) {
          throw new Error('Divider missing during drag')
        }
        // Move perpendicular to the resize axis so active-drag feedback cannot shift the panes.
        await orcaPage.mouse.move(
          orientation === 'vertical' ? bounds.x + bounds.width / 2 : 0,
          orientation === 'horizontal' ? bounds.y + bounds.height / 2 : 0
        )
        const dragged = await readDivider(handle)
        samples.push({ state: 'drag', ...dragged })
        await capture('drag')
        await orcaPage.mouse.up()
        await expect(handle).not.toHaveClass(/is-dragging/)
        await capture('release')
        const released = await readDivider(handle)
        samples.push({ state: 'release', ...released })
        expect(released.hovered).toBe(false)
        // Pointer capture retains :hover during the real gesture; also isolate the drag-only CSS state.
        await handle.evaluate((element) => element.classList.add('is-dragging'))
        await capture('drag-without-hover')
        const dragOnly = await readDivider(handle)
        samples.push({ state: 'drag-without-hover', ...dragOnly })
        expect(dragOnly.hovered).toBe(false)
        await handle.evaluate((element) => element.classList.remove('is-dragging'))
        const geometryPath = testInfo.outputPath(`${color.slice(1)}-geometry.json`)
        writeFileSync(geometryPath, JSON.stringify(samples, null, 2))
        await testInfo.attach(`${color}-geometry`, {
          path: geometryPath,
          contentType: 'application/json'
        })
        for (const sample of samples) {
          expect.soft(sample.hitThickness, sample.state).toBe(6)
          expect.soft(sample.centered, sample.state).toBe(true)
          expect.soft(sample.baseColor, sample.state).toBe(color)
          expect.soft(sample.layout, sample.state).toEqual(idle.layout)
          expect
            .soft(sample.thickness, sample.state)
            .toBe(sample.state === 'hover' || sample.state.startsWith('drag') ? 4 : 3)
        }
        expect.soft(dragged.color).toBe(hovered.color)
        expect.soft(dragOnly.color).toBe(hovered.color)
        expect.soft(released.color).toBe(idle.color)
      }
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused()
          )
        )
      ).toBe(true)
    })
  }
}
