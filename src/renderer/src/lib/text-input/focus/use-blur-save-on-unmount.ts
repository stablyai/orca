import { useEffect, useEffectEvent } from 'react'

/**
 * React runs no onBlur for a focused field that unmounts, so a blur-to-save draft is lost when its
 * list row scrolls out of a virtualized list or its owner goes away. Saves it on unmount while
 * `editing`. Call it from the component that outlives the field, so StrictMode's mount check sees no edit.
 */
export function useBlurSaveOnUnmount(editing: boolean, save: () => unknown): void {
  const saveIfEditing = useEffectEvent(() => {
    if (editing) {
      void save()
    }
  })
  useEffect(() => () => saveIfEditing(), [])
}
