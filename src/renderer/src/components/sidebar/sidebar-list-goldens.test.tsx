// @vitest-environment happy-dom

/** Snapshot visible row order from the window pipeline; golden changes need review as visible behavior changes. */
import { defineSidebarListGoldens } from './sidebar-list-golden-suite.test-fixture'

defineSidebarListGoldens('./__goldens__/sidebar-list')
