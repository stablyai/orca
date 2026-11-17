import { expect, test, type Page } from '@playwright/test'

// Composer a11y: Tab focus never opens a picker, focus is drawn with the shared --focus-ring
// token, and no option in the Project or Run on lists nests an interactive control (axe's
// nested-interactive rule, checked here directly: the repo has no axe dependency).

const THEMES = ['light', 'dark'] as const

const TAB_WALK_FIXTURES = [
  'new-workspace/NewWorkspaceComposerProjectSection:closed',
  'new-workspace/ComposerParentWorktreePicker:parentPickerClosed',
  'new-workspace/NewWorkspaceComposerNameSection:newBranch'
] as const

// Lists that render options, including the needs-setup rows with Connect / Set project location.
const OPEN_LIST_FIXTURES = [
  'new-workspace/NewWorkspaceComposerProjectSection:projectMenu',
  'new-workspace/NewWorkspaceComposerProjectSection:hostMenu',
  'new-workspace/NewWorkspaceComposerProjectSection:hostMenuOrcaCloud',
  'new-workspace/RunTargetCombobox:vmSelected',
  'new-workspace/RunTargetCombobox:rowActions',
  'new-workspace/RunTargetCombobox:orcaCloudEntitled'
] as const

async function open(page: Page, id: string, theme: string): Promise<void> {
  await page.goto(`/fixtures.html?id=${id}&theme=${theme}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
}

/** The focus-ring token as the browser serializes it, from a probe element. */
async function focusRingColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--focus-ring)'
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
}

/** Ring, outline and border colors drawn around the focused control or its focus-within shell. */
async function focusPaint(
  page: Page
): Promise<{ tag: string; paint: string; inScope: boolean } | null> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || active === document.body) {
      return null
    }
    const paints: string[] = []
    for (
      let node: HTMLElement | null = active, depth = 0;
      node && depth < 4;
      node = node.parentElement, depth++
    ) {
      const style = getComputedStyle(node)
      paints.push(style.boxShadow, style.outlineStyle === 'none' ? '' : style.outlineColor)
    }
    const role = active.getAttribute('role')
    const inScope =
      role === 'combobox' ||
      role === 'switch' ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    return {
      inScope,
      tag: `${active.tagName.toLowerCase()}[${active.getAttribute('role') ?? ''}] ${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 30) ?? ''}`,
      paint: paints.join(' | ')
    }
  })
}

for (const theme of THEMES) {
  for (const id of TAB_WALK_FIXTURES) {
    test(`${id} [${theme}]: Tab never opens a list and focus uses --focus-ring`, async ({
      page
    }) => {
      await open(page, id, theme)
      const ring = await focusRingColor(page)
      const seen = new Set<string>()
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        // Nothing opens on focus: no listbox, no expanded combobox.
        await expect(page.locator('[role="listbox"]')).toHaveCount(0)
        await expect(page.locator('[role="combobox"][aria-expanded="true"]')).toHaveCount(0)
        const focused = await focusPaint(page)
        // The composer's controls: the comboboxes, fields and the create-multiple switch.
        if (!focused || !focused.inScope || seen.has(focused.tag)) {
          continue
        }
        seen.add(focused.tag)
        // The shells animate box-shadow; poll until the ring has drawn.
        await expect
          .poll(async () => (await focusPaint(page))?.paint ?? '', {
            message: `focus paint of ${focused.tag}`
          })
          .toContain(ring)
      }
      expect(seen.size).toBeGreaterThan(0)
    })
  }

  test(`project and run-on open on ArrowDown and click, not focus [${theme}]`, async ({ page }) => {
    await open(page, 'new-workspace/NewWorkspaceComposerProjectSection:closed', theme)
    for (const name of ['Project', 'Run on']) {
      const field = page.getByRole('combobox', { name })
      await field.focus()
      await expect(field).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('ArrowDown')
      await expect(field).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
      await expect(field).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Alt+ArrowDown')
      await expect(field).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
      await field.click()
      await expect(field).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
    }
  })

  for (const id of OPEN_LIST_FIXTURES) {
    test(`${id} [${theme}]: no option nests an interactive control`, async ({ page }) => {
      await open(page, id, theme)
      const options = page.locator('[role="option"]')
      await expect(options.first()).toBeVisible()
      const nested = await page.evaluate(() => {
        // axe nested-interactive: a children-presentational role (option) can't hold anything
        // focusable or interactive, tabindex -1 included.
        const interactive =
          'a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable=""],[contenteditable="true"],' +
          '[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="textbox"]'
        return Array.from(document.querySelectorAll('[role="option"]')).flatMap((option) =>
          Array.from(option.querySelectorAll(interactive)).map(
            (node) => `${option.id}: <${node.tagName.toLowerCase()}> ${node.textContent?.trim()}`
          )
        )
      })
      expect(nested).toEqual([])
    })
  }
}
