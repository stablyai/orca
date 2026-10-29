/** Read authority-qualified row keys and render order from the mocked list panel, matching real clicks rather than synthesizing identity. */

import type { AutomationListRow } from './automation-list-row-identity'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import { mocks } from './automations-page-test-harness'

function listedItems() {
  return mocks.listPanel?.sortedListItems ?? []
}

/** Local rows the page listed, in render order. */
export function listedRows(): readonly AutomationListRow[] {
  return listedItems().flatMap((item) => (item.kind === 'local' ? [item.row] : []))
}

/** External entries the page listed, in render order. */
export function listedExternalEntries(): readonly ExternalAutomationListEntry[] {
  return listedItems().flatMap((item) => (item.kind === 'external' ? [item.entry] : []))
}

export function listedRow(automationId: string): AutomationListRow {
  const row = listedRows().find((entry) => entry.automation.id === automationId)
  if (!row) {
    throw new Error(`no listed row for ${automationId}`)
  }
  return row
}
