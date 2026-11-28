import { test } from '@stablyai/playwright-test'
import { LAYOUT_OWNER_BUILD } from './layout-owner-build'

/** A switch-on failure the 2026-11-28 census recorded; the test turns red when the bug is fixed, so drop the mark then. */
export function knownSwitchOnFailure(censusRow: string): void {
  test.fail(LAYOUT_OWNER_BUILD, `known switch-on failure, census row ${censusRow}`)
}
