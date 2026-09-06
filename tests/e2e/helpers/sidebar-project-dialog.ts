import { expect, type Page } from '@stablyai/playwright-test'

export async function openSidebarProjectDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = window as any
    const events: unknown[] = []
    const describe = (element: Element | null) => element ? { tag: element.tagName, role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 80), classes: element.className } : null
    const record = (event: unknown) => { events.push({ at: performance.now(), event }); if (events.length > 80) events.shift() }
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args) {
      record({ kind: 'focus-call', target: describe(this), stack: new Error().stack })
      return focus.apply(this, args)
    }
    const onFocus = (event: FocusEvent) => record({ kind: event.type, target: describe(event.target as Element), related: describe(event.relatedTarget as Element) })
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('focusout', onFocus, true)
    let previous = ''
    const observer = new MutationObserver(() => {
      const state = JSON.stringify(Array.from(document.querySelectorAll('[role="menu"]')).map(element => ({ state: element.getAttribute('data-state'), text: element.textContent?.slice(0, 160) })))
      if (state !== previous) { previous = state; record({ kind: 'menus', state, active: describe(document.activeElement) }) }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
    root.__sidebarMenuDiagnostic = { events, dispose: () => { HTMLElement.prototype.focus = focus; observer.disconnect(); document.removeEventListener('focusin', onFocus, true); document.removeEventListener('focusout', onFocus, true) } }
    window.__store!.getState().setSidebarWidth(220)
  })
  try {
    await page.getByRole('button', { name: 'More workspace actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add Project', exact: true }).click()
    await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
  } finally {
    const events = await page.evaluate(() => { const diagnostic = (window as any).__sidebarMenuDiagnostic; diagnostic.dispose(); return diagnostic.events })
    console.info('[sidebar-menu-diagnostic] ' + JSON.stringify(events))
  }
}
