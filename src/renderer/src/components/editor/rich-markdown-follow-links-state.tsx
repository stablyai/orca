import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react'

export type RichMarkdownFollowLinksState = {
  active: boolean
  onToggle: () => void
}

const RichMarkdownFollowLinksContext = createContext<RichMarkdownFollowLinksState | null>(null)

export function RichMarkdownFollowLinksProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [active, setActive] = useState(false)
  const onToggle = useCallback(() => setActive((current) => !current), [])
  const value = useMemo(() => ({ active, onToggle }), [active, onToggle])

  return (
    <RichMarkdownFollowLinksContext.Provider value={value}>
      {children}
    </RichMarkdownFollowLinksContext.Provider>
  )
}

export function useRichMarkdownFollowLinks(): RichMarkdownFollowLinksState | null {
  return useContext(RichMarkdownFollowLinksContext)
}

export function useCommittedRichMarkdownFollowLinksRef(active: boolean): MutableRefObject<boolean> {
  const activeRef = useRef(active)

  useLayoutEffect(() => {
    // Why: ProseMirror handlers must not observe state from a discarded React render.
    activeRef.current = active
  }, [active])

  return activeRef
}
