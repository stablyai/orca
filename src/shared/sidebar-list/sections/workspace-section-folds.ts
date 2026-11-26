export type WorkspaceListSection = 'projects' | 'chats'

const CHAT_FOLD_PREFIX = 'chats:'

export function workspaceSectionFoldKey(section: WorkspaceListSection, key: string): string {
  return section === 'chats' ? `${CHAT_FOLD_PREFIX}${key}` : key
}

export function workspaceSectionFolds(
  groups: Set<string>,
  section: WorkspaceListSection
): Set<string> {
  if (section === 'projects' && ![...groups].some((key) => key.startsWith(CHAT_FOLD_PREFIX))) {
    return groups
  }
  return new Set(
    [...groups].flatMap((key) =>
      section === 'chats'
        ? key.startsWith(CHAT_FOLD_PREFIX)
          ? [key.slice(CHAT_FOLD_PREFIX.length)]
          : []
        : key.startsWith(CHAT_FOLD_PREFIX)
          ? []
          : [key]
    )
  )
}

export function replaceWorkspaceSectionFolds(
  current: Set<string>,
  next: Set<string>,
  section: WorkspaceListSection
): Set<string> {
  const preserved = [...current].filter((key) =>
    section === 'chats' ? !key.startsWith(CHAT_FOLD_PREFIX) : key.startsWith(CHAT_FOLD_PREFIX)
  )
  return new Set([...preserved, ...[...next].map((key) => workspaceSectionFoldKey(section, key))])
}
