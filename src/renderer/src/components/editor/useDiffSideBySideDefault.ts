import { useState, type Dispatch, type SetStateAction } from 'react'

export function useDiffSideBySideDefault(
  diffDefaultView: 'side-by-side' | 'inline' | undefined
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [sideBySide, setSideBySide] = useState(diffDefaultView === 'side-by-side')
  const [prevDiffView, setPrevDiffView] = useState(diffDefaultView)

  if (diffDefaultView !== prevDiffView) {
    setPrevDiffView(diffDefaultView)
    if (diffDefaultView !== undefined) {
      setSideBySide(diffDefaultView === 'side-by-side')
    }
  }

  return [sideBySide, setSideBySide]
}
