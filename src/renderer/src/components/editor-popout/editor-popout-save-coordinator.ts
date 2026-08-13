export type EditorPopoutSaveSlot = {
  current: Promise<boolean> | null
}

export function isEditorPopoutContentDirty(content: string, savedContent: string): boolean {
  return content !== savedContent
}

export function canCloseEditorPopoutAfterSave(
  saved: boolean,
  savedSnapshot: string,
  currentContent: string
): boolean {
  return saved && savedSnapshot === currentContent
}

export function runEditorPopoutSave(
  slot: EditorPopoutSaveSlot,
  task: () => Promise<boolean>
): Promise<boolean> {
  const pending = slot.current
    ? slot.current.then(
        () => task(),
        () => task()
      )
    : task()
  slot.current = pending
  void pending.then(
    () => {
      if (slot.current === pending) {
        slot.current = null
      }
    },
    () => {
      if (slot.current === pending) {
        slot.current = null
      }
    }
  )
  return pending
}
