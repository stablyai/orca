import { useState } from 'react'
import { useMeasuredWidth } from '@/components/right-sidebar/layout/right-sidebar-measured-width'

export function useLineageGuideWidth(): [number | null, ReturnType<typeof useMeasuredWidth>] {
  const [guideWidth, setGuideWidth] = useState<number | null>(null)
  return [guideWidth, useMeasuredWidth(setGuideWidth)]
}
