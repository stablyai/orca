/** Props of the layout boxes `Row` and `Stack`. */
const BOX_PROPS = [
  'gap',
  'align',
  'justify',
  'fill',
  'grow',
  'keep',
  'push',
  'inset',
  'overflow',
  'hoverGroup',
  'marker'
] as const

/** Every element a card template can name, with the props it accepts. The renderer draws each
 *  one; `plugin check` and plugin loading validate templates against this list. */
export const CARD_ELEMENT_PROPS = {
  Row: BOX_PROPS,
  Stack: BOX_PROPS,
  Text: ['text', 'size', 'tone', 'muted', 'weight', 'mono', 'truncate'],
  Badge: ['text', 'tone'],
  Icon: ['name', 'tone'],
  Title: ['dimWhenRead', 'tooltip'],
  RepoChip: [],
  SshControl: ['iconOnly'],
  RuntimeHostMark: [],
  RenameError: [],
  PrimaryBadge: [],
  PrimaryStar: [],
  SparseBadge: [],
  DeleteQuickAction: [],
  MetaRepoBadge: [],
  HostBadge: [],
  Branch: ['tooltip'],
  IdentityLabel: ['tooltip'],
  FolderPath: [],
  DetachedHead: [],
  ConflictBadge: [],
  CacheTimer: [],
  StatusLane: ['unreadAction'],
  Agents: ['tight'],
  RemoteBranchConflict: [],
  DeleteFailed: [],
  LinearSetupPrompt: [],
  ChildToggle: [],
  Indicators: ['hover'],
  DetailsHover: []
} as const satisfies Record<string, readonly string[]>

export type CardElementName = keyof typeof CARD_ELEMENT_PROPS

export function isCardElementName(name: string): name is CardElementName {
  return Object.hasOwn(CARD_ELEMENT_PROPS, name)
}
