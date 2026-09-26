import { z } from 'zod'
import type {
  RecoveryLayout,
  RecoveryTab,
  RecoveryTabGroup,
  RecoveryTerminalLayout,
  RecoveryTerminalTab
} from '../cross-machine-recovery-descriptor'
import type { TabGroupLayoutNode } from '../tab-types'
import { isValidTerminalTabId } from '../terminal-tab-id'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent } from '../tui-agent-config'
import {
  MAX_PANE_LAYOUT_DEPTH,
  MAX_PANE_LAYOUT_NODES,
  TerminalPaneLayoutNodeSchema
} from './session-tabs-schemas-params'

export const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 4096
export const MAX_PATH_LENGTH = 32_768
const MAX_RECOVERY_TABS = 1024
const MAX_RECOVERY_BROWSERS = 64
const MAX_RECOVERY_BROWSER_PAGES = 256

export const Id = z.string().min(1).max(MAX_ID_LENGTH)
// Why: editor tab ids and worktree ids embed absolute paths, so they outgrow plain ids.
export const PathId = z.string().min(1).max(MAX_PATH_LENGTH)
export const Label = z.string().max(MAX_LABEL_LENGTH)
const RelativePath = z.string().max(MAX_PATH_LENGTH)
export const Timestamp = z.number().finite().nonnegative()
export const TuiAgentSchema = z.custom<TuiAgent>((value) => isTuiAgent(value))

export const utf8Text = (maxBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, 'Text is too large')

const RecordKey = Id.refine(
  (key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype',
  'Invalid record key'
)

export const boundedRecord = <V extends z.ZodType>(value: V, maxEntries: number) =>
  z
    .record(RecordKey, value)
    .refine((record) => Object.keys(record).length <= maxEntries, 'Too many entries')

const TAB_GROUP_SPLIT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'direction',
  'first',
  'second',
  'ratio'
])

// Why: descriptors arrive from another machine; walk the tree iteratively with the pane-layout
// caps so a hostile nesting depth cannot overflow the main-process stack.
function isBoundedTabGroupLayoutNode(value: unknown): value is TabGroupLayoutNode {
  let nodeCount = 0
  const stack: { raw: unknown; depth: number }[] = [{ raw: value, depth: 0 }]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { raw, depth } = next
    nodeCount += 1
    if (depth > MAX_PANE_LAYOUT_DEPTH || nodeCount > MAX_PANE_LAYOUT_NODES) {
      return false
    }
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      return false
    }
    if (raw.type === 'leaf') {
      if (!('groupId' in raw) || !Id.safeParse(raw.groupId).success) {
        return false
      }
      if (Object.keys(raw).length !== 2) {
        return false
      }
      continue
    }
    if (raw.type !== 'split' || !('first' in raw) || !('second' in raw) || !('direction' in raw)) {
      return false
    }
    if (raw.direction !== 'horizontal' && raw.direction !== 'vertical') {
      return false
    }
    const ratio = 'ratio' in raw ? raw.ratio : undefined
    if (
      ratio !== undefined &&
      (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    ) {
      return false
    }
    if (Object.keys(raw).some((key) => !TAB_GROUP_SPLIT_KEYS.has(key))) {
      return false
    }
    stack.push({ raw: raw.first, depth: depth + 1 }, { raw: raw.second, depth: depth + 1 })
  }
  return true
}

const TabGroupLayoutNodeSchema = z.custom<TabGroupLayoutNode>(
  (value) => isBoundedTabGroupLayoutNode(value),
  { message: 'Invalid or too-deep tab group layout tree' }
)

const AiVaultTitleSchema = z
  .object({ agent: z.enum(['claude', 'codex']), sessionId: Id, title: Label })
  .strict()

const ViewModeSchema = z.enum(['terminal', 'chat'])

const RecoveryTabSchema: z.ZodType<RecoveryTab> = z
  .object({
    id: PathId,
    entityId: PathId,
    groupId: Id,
    contentType: z.enum([
      'terminal',
      'editor',
      'diff',
      'conflict-review',
      'check-details',
      'agent-session',
      'browser',
      'simulator'
    ]),
    label: Label,
    generatedLabel: Label.nullable().optional(),
    aiVaultTitle: AiVaultTitleSchema.nullable().optional(),
    quickCommandLabel: Label.nullable().optional(),
    customLabel: Label.nullable(),
    color: Label.nullable(),
    sortOrder: z.number().finite(),
    createdAt: Timestamp,
    isPreview: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    agentSessionAgent: Id.optional(),
    viewMode: ViewModeSchema.optional(),
    lastFocusedAt: Timestamp.optional()
  })
  .strict()

const RecoveryTabGroupSchema: z.ZodType<RecoveryTabGroup> = z
  .object({
    id: Id,
    activeTabId: PathId.nullable(),
    tabOrder: z.array(PathId).max(MAX_RECOVERY_TABS),
    recentTabIds: z.array(PathId).max(MAX_RECOVERY_TABS).optional()
  })
  .strict()

const RecoveryTerminalTabSchema: z.ZodType<RecoveryTerminalTab> = z
  .object({
    id: Id.refine(isValidTerminalTabId, 'Invalid terminal tab ID'),
    title: Label,
    defaultTitle: Label.optional(),
    generatedTitle: Label.nullable().optional(),
    aiVaultTitle: AiVaultTitleSchema.nullable().optional(),
    quickCommandLabel: Label.nullable().optional(),
    customTitle: Label.nullable(),
    color: Label.nullable(),
    isPinned: z.boolean().optional(),
    viewMode: ViewModeSchema.optional(),
    sortOrder: z.number().finite(),
    createdAt: Timestamp,
    startupCwd: PathId.optional(),
    launchAgent: TuiAgentSchema.optional()
  })
  .strict()

const RecoveryTerminalLayoutSchema: z.ZodType<RecoveryTerminalLayout> = z
  .object({
    root: TerminalPaneLayoutNodeSchema.nullable(),
    activeLeafId: Id.nullable(),
    expandedLeafId: Id.nullable(),
    chatLeafId: Id.optional(),
    titlesByLeafId: boundedRecord(Label, MAX_PANE_LAYOUT_NODES).optional()
  })
  .strict()

export const RecoveryLayoutSchema: z.ZodType<RecoveryLayout> = z
  .object({
    tabs: z.array(RecoveryTabSchema).max(MAX_RECOVERY_TABS),
    groups: z.array(RecoveryTabGroupSchema).max(MAX_RECOVERY_TABS),
    groupLayout: TabGroupLayoutNodeSchema.nullable(),
    activeGroupId: Id.nullable(),
    terminalTabs: z.array(RecoveryTerminalTabSchema).max(MAX_RECOVERY_TABS),
    terminalLayouts: boundedRecord(RecoveryTerminalLayoutSchema, MAX_RECOVERY_TABS),
    startupCwdRelative: boundedRecord(RelativePath, MAX_RECOVERY_TABS),
    editors: z
      .array(
        z
          .object({
            relativePath: PathId,
            language: Label,
            isPreview: z.boolean().optional(),
            readOnly: z.boolean().optional()
          })
          .strict()
      )
      .max(MAX_RECOVERY_TABS),
    activeEditorRelativePath: PathId.nullable(),
    browsers: z
      .array(
        z
          .object({
            id: Id,
            label: Label.optional(),
            activePageId: Id.nullable(),
            pages: z
              .array(z.object({ id: Id, url: PathId, title: Label.optional() }).strict())
              .max(MAX_RECOVERY_BROWSER_PAGES)
          })
          .strict()
      )
      .max(MAX_RECOVERY_BROWSERS),
    activeBrowserId: Id.nullable(),
    activeTabType: z
      .enum(['terminal', 'editor', 'agent-session', 'browser', 'simulator'])
      .nullable(),
    activeTabId: PathId.nullable()
  })
  .strict()
