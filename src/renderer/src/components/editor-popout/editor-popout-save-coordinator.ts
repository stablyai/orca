export type EditorPopoutSaveSlot = {
  current: Promise<boolean> | null
}

export function runEditorPopoutSave(
  slot: EditorPopoutSaveSlot,
  task: () => Promise<boolean>
): Promise<boolean> {
  if (slot.current) {
    return slot.current
  }

  const pending = task()
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
