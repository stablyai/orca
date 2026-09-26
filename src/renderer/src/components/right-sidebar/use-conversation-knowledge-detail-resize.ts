import { useState } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'

export function useConversationKnowledgeDetailResize(): ReturnType<
  typeof useSidebarResize<HTMLDivElement>
> {
  const [width, setWidth] = useState(360)
  return useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width,
    minWidth: 280,
    maxWidth: 720,
    deltaSign: -1,
    setWidth
  })
}
