import { memo, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { markdownWordTokens } from './comment-markdown-word-fade'

type FadeArrival = { end: number; at: number }
type FadeWindow = { text: string; arrivals: FadeArrival[] }

/** One clock per text node; settled words become one plain text prefix. */
export const CommentMarkdownWords = memo(function CommentMarkdownWords({
  node,
  children,
  ...props
}: ComponentProps<'span'> & ExtraProps): React.ReactNode {
  const wordGroup = node?.properties.dataWordGroup !== undefined
  const text = wordGroup ? String(children ?? '') : ''
  const [initial] = useState<FadeWindow>(() => ({
    text,
    arrivals: [{ end: text.length, at: performance.now() }]
  }))
  const groupRef = useRef<HTMLSpanElement>(null)
  const fadeWindow = useRef(initial)
  const [settled, setSettled] = useState(0)
  useLayoutEffect(() => {
    if (!wordGroup) {
      return
    }
    const current = fadeWindow.current
    // Clock new words at commit, so abandoned renders never schedule a fade.
    if (current.text !== text) {
      if (!text.startsWith(current.text)) {
        current.arrivals = []
        setSettled(0)
      }
      current.text = text
      current.arrivals.push({ end: text.length, at: performance.now() })
    }
    let timer = 0
    const selected = (): boolean => {
      const selection = document.getSelection()
      const group = groupRef.current
      return Boolean(
        group &&
        selection &&
        !selection.isCollapsed &&
        (group.contains(selection.anchorNode) ||
          group.contains(selection.focusNode) ||
          selection.containsNode(group, true))
      )
    }
    const schedule = (): void => {
      const first = current.arrivals[0]
      if (!first) {
        document.removeEventListener('selectionchange', onSelectionChange)
        return
      }
      timer = window.setTimeout(
        () => {
          if (selected()) {
            return
          }
          const now = performance.now()
          let end = 0
          current.arrivals = current.arrivals.filter((arrival) => {
            if (arrival.at + 300 > now) {
              return true
            }
            end = Math.max(end, arrival.end)
            return false
          })
          if (end > 0) {
            setSettled(end)
          }
          schedule()
        },
        Math.max(0, first.at + 300 - performance.now())
      )
    }
    const onSelectionChange = (): void => {
      window.clearTimeout(timer)
      if (!selected()) {
        schedule()
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    schedule()
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [text, wordGroup])
  if (!wordGroup) {
    return <span {...props}>{children}</span>
  }
  return (
    <span ref={groupRef} data-word-group="">
      {text.slice(0, settled)}
      {markdownWordTokens(text.slice(settled)).map(({ value, offset }) =>
        value.trim() === '' ? (
          value
        ) : (
          <span key={settled + offset} data-word="">
            {value}
          </span>
        )
      )}
    </span>
  )
})
