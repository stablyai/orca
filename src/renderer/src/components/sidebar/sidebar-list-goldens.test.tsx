// @vitest-environment happy-dom

/**
 * Golden fixtures of the sidebar row model, captured from the unmodified window
 * pipeline (filter, sort, grouping, pins, lineage, host sections) and kept as the
 * correctness reference for any change that moves or reshapes that pipeline.
 * A diff in these files is a visible change and needs its own review.
 */
import { defineSidebarListGoldens } from './sidebar-list-golden-suite.test-fixture'

defineSidebarListGoldens('./__goldens__/sidebar-list')
