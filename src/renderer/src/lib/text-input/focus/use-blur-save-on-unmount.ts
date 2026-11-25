import { useEffect, useEffectEvent } from 'react'

/**
 * React runs no onBlur for a focused field that unmounts, so a blur-to-save draft is lost when its
 * list row scrolls out of a virtualized list or its owner goes away. Saves it on unmount while
 * `isEditing()` holds. Require both the committed editing state and a synchronous flag: a cancel,
 * or a parent remounting the title as editing starts, can unmount it before that state commits.
 * Call it from the component that outlives the field.
 */
export function useBlurSaveOnUnmount(isEditing: () => boolean, save: () => unknown): void {
  const saveIfEditing = useEffectEvent(() => {
    if (isEditing()) {
      void save()
    }
  })
  useEffect(() => () => saveIfEditing(), [])
}
