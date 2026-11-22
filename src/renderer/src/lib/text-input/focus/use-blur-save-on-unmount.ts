import { useEffect, useEffectEvent } from 'react'

/**
 * React runs no onBlur for a focused field that unmounts, so a blur-to-save draft is lost when its
 * list row scrolls out of a virtualized list or its owner goes away. Saves it on unmount while
 * `isEditing()` holds. Read a synchronous flag there: a cancel can unmount the field before its
 * state update commits. Call it from the component that outlives the field.
 */
export function useBlurSaveOnUnmount(isEditing: () => boolean, save: () => unknown): void {
  const saveIfEditing = useEffectEvent(() => {
    if (isEditing()) {
      void save()
    }
  })
  useEffect(() => () => saveIfEditing(), [])
}
