/** Caps on one `ui.render` tree. Generous for a sidebar panel, small enough to validate per frame. */
export const PLUGIN_DECLARATIVE_LIMITS = {
  maxNodes: 5000,
  maxDepth: 64,
  /** Approximate serialized size: string lengths plus a fixed cost per node and prop. */
  maxTreeBytes: 512 * 1024,
  maxTextLength: 16 * 1024,
  maxLabelLength: 1024,
  maxPropsPerNode: 32,
  maxSelectOptions: 500,
  maxEventArgs: 8,
  maxCallbackIdLength: 64,
  maxRadioOptions: 50,
  maxTableColumns: 32,
  maxTableRows: 5000,
  /** Items across every level of one Tree, and how deep it nests. */
  maxTreeItems: 2000,
  maxTreeItemDepth: 16,
  maxKeyValueItems: 200,
  /** Markdown and CodeView text: more than one text child, still inside the tree byte budget. */
  maxDocumentLength: 64 * 1024,
  /** Keys or values in one object-shaped event argument (Table selection, sort). */
  maxEventArgItems: 5000
} as const

/** Host lane for `ui.render`/`ui.persist`; the guest preload's render lane mirrors it. */
export const PLUGIN_DECLARATIVE_RENDER_LANE = {
  maxBytes: 640 * 1024,
  maxMessages: 200,
  perMs: 10_000,
  // Every tree the parser accepts must be metered, not refused: a node nests two levels (node,
  // children array) plus props. The byte cap still bounds the walk's work.
  maxDepth: PLUGIN_DECLARATIVE_LIMITS.maxDepth * 2 + 24,
  maxObjects: PLUGIN_DECLARATIVE_LIMITS.maxNodes * 8 + 1024
} as const
