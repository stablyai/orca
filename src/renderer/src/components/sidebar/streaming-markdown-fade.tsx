import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { Components } from 'react-markdown'

const SEGMENT_DELAY_MS = 16
const MAX_SEGMENT_DELAY_MS = 96
const FADE_DURATION_MS = 150

type FadeTimeline = {
  active: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
  dispose: () => void
  nextSegmentStartAt: number
  starts: Map<string, number>
  settled: Set<string>
}

type FadeRegistry = Map<string, FadeTimeline>

type MarkdownNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}

export type StreamingMarkdownFade = {
  id: string
  start: boolean
}

const FadeRegistryContext = createContext<FadeRegistry | null>(null)

export function StreamingMarkdownFadeProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const registryRef = useRef<FadeRegistry>(new Map())
  return (
    <FadeRegistryContext.Provider value={registryRef.current}>
      {children}
    </FadeRegistryContext.Provider>
  )
}

export const StreamingMarkdownFadeRoot = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'>
>(function StreamingMarkdownFadeRoot({ children, ...props }, ref) {
  return (
    <StreamingMarkdownFadeProvider>
      <div ref={ref} {...props}>
        {children}
      </div>
    </StreamingMarkdownFadeProvider>
  )
})

export function useStreamingMarkdownFade(
  fade: StreamingMarkdownFade | undefined,
  content: string
): {
  component: Components['span'] | undefined
  plugin: (() => (tree: MarkdownNode) => void) | undefined
} {
  const inheritedRegistry = useContext(FadeRegistryContext)
  const localRegistryRef = useRef<FadeRegistry>(new Map())
  const registry = inheritedRegistry ?? localRegistryRef.current
  const fadeId = fade?.id
  const startsFade = fade?.start === true
  const timeline = useMemo(() => {
    if (!fadeId) {
      return null
    }
    const existing = registry.get(fadeId)
    if (existing || !startsFade) {
      return existing ?? null
    }
    const created: FadeTimeline = {
      active: true,
      dispose: () => {
        if (registry.get(fadeId) === created) {
          registry.delete(fadeId)
        }
      },
      nextSegmentStartAt: 0,
      starts: new Map(),
      settled: new Set()
    }
    registry.set(fadeId, created)
    return created
  }, [fadeId, registry, startsFade])

  useEffect(() => {
    if (!timeline) {
      return
    }
    timeline.active = startsFade
    scheduleTimelineCleanup(timeline)
    return () => {
      timeline.active = false
      scheduleTimelineCleanup(timeline)
    }
  }, [content, startsFade, timeline])

  return useMemo(() => {
    if (!timeline) {
      return { component: undefined, plugin: undefined }
    }
    return {
      component: createFadeSpan(timeline),
      plugin: createFadePlugin()
    }
  }, [timeline])
}

function createFadePlugin(): () => (tree: MarkdownNode) => void {
  return () => (tree) => {
    let textOffset = 0
    const visit = (node: MarkdownNode, blocked: boolean): void => {
      const blocksFade = blocked || node.tagName === 'code' || node.tagName === 'pre'
      if (!node.children) {
        if (node.type === 'text') {
          textOffset += node.value?.length ?? 0
        }
        return
      }
      const children: MarkdownNode[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || blocksFade || !child.value) {
          visit(child, blocksFade)
          children.push(child)
          continue
        }
        let segmentOffset = 0
        for (const segment of segmentWords(child.value)) {
          children.push({
            type: 'element',
            tagName: 'span',
            properties: {
              'data-streaming-fade-key': `${textOffset + segmentOffset}`
            },
            children: [{ type: 'text', value: segment }]
          })
          segmentOffset += segment.length
        }
        textOffset += child.value.length
      }
      node.children = children
    }
    visit(tree, false)
  }
}

function createFadeSpan(timeline: FadeTimeline): Components['span'] {
  return function FadeSpan({ node: _node, ...props }): React.JSX.Element {
    const attributes = props as Record<string, unknown>
    const segmentKey = attributes['data-streaming-fade-key']
    if (typeof segmentKey !== 'string') {
      return <span {...props} />
    }
    const now = currentTime()
    const startAt = scheduleSegment(timeline, segmentKey, now)
    if (timeline.settled.has(segmentKey) || now >= startAt + FADE_DURATION_MS) {
      timeline.settled.add(segmentKey)
      return <span {...props} />
    }
    return (
      <span
        {...props}
        className="streaming-markdown-fade-segment"
        style={
          {
            '--streaming-markdown-fade-delay': `${Math.round(startAt - now)}ms`
          } as React.CSSProperties
        }
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) {
            timeline.settled.add(segmentKey)
          }
        }}
      />
    )
  }
}

function scheduleSegment(timeline: FadeTimeline, key: string, now: number): number {
  const existing = timeline.starts.get(key)
  if (existing !== undefined) {
    return existing
  }
  const startAt = Math.max(timeline.nextSegmentStartAt, now)
  timeline.starts.set(key, startAt)
  const delay = startAt - now
  timeline.nextSegmentStartAt =
    startAt + (delay < MAX_SEGMENT_DELAY_MS ? SEGMENT_DELAY_MS : SEGMENT_DELAY_MS / 4)
  return startAt
}

function scheduleTimelineCleanup(timeline: FadeTimeline): void {
  if (timeline.cleanupTimer) {
    clearTimeout(timeline.cleanupTimer)
    timeline.cleanupTimer = undefined
  }
  if (timeline.active) {
    return
  }
  const remainingMs = Math.max(0, timeline.nextSegmentStartAt - currentTime()) + FADE_DURATION_MS
  timeline.cleanupTimer = setTimeout(timeline.dispose, remainingMs)
}

function currentTime(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

export function segmentWords(text: string): string[] {
  if (isAscii(text)) {
    const segments: string[] = []
    let index = 0
    while (index < text.length) {
      if (isAsciiWordCharacter(text, index)) {
        const start = index
        while (isAsciiWordCharacter(text, index)) {
          index += 1
        }
        segments.push(text.slice(start, index))
      } else {
        const target = Math.max(segments.length - 1, 0)
        segments[target] = (segments[target] ?? '') + text[index]
        index += 1
      }
    }
    return segments
  }
  try {
    const segments: string[] = []
    for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
      if (!part.isWordLike || /^\s*$/u.test(part.segment)) {
        const target = Math.max(segments.length - 1, 0)
        segments[target] = (segments[target] ?? '') + part.segment
      } else {
        segments.push(part.segment)
      }
    }
    return segments
  } catch {
    return Array.from(text.match(/\s*\S+(?:\s+|$)/g) ?? [text])
  }
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) {
      return false
    }
  }
  return true
}

function isAsciiWordCharacter(text: string, index: number): boolean {
  if (index >= text.length) {
    return false
  }
  const code = text.charCodeAt(index)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}
