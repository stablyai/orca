// Selectors whose subtree must NOT dismiss the non-modal Odoo ticket Sheet.
// The panel is click-through (transparent, pointer-events-none overlay), so
// Radix reports every page click as "outside" — including clicks on another
// ticket row, which must swap the detail rather than close it.
const ODOO_TICKET_PANEL_KEEP_OPEN_SELECTOR = [
  '[data-odoo-panel]',
  '[data-radix-popper-content-wrapper]',
  '[data-slot="select-content"]',
  '[data-sonner-toast]'
].join(', ')

export function isOdooTicketPanelKeepOpenTarget(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  // Why: filter dropdowns portal to document.body, so DOM containment against
  // the panel alone would treat their clicks as a dismiss.
  return Boolean(element?.closest(ODOO_TICKET_PANEL_KEEP_OPEN_SELECTOR))
}
