import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import {
  useGitHubImageEvents,
  useGitHubImageUploads,
  type GitHubImageIntake
} from './use-github-image-uploads'

type Marker = { start: number; end: number; id: string }
type Shadow = { body: string; display: string; markers: Marker[] }

export function useGitHubTextareaImages(
  textarea: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (value: string) => void,
  options: GitHubImageIntake
) {
  const [shadow, setShadow] = useState<Shadow>({ body: value, display: value, markers: [] })
  const current = useRef(shadow)
  const changeRef = useRef(onChange)
  const before = useRef<{ start: number; end: number } | null>(null)
  const known = useRef(new Set<string>())
  const uploads = useGitHubImageUploads(options)
  const displayed = shadow.body === value ? shadow : { body: value, display: value, markers: [] }
  useLayoutEffect(() => {
    if (current.current.body !== value) {
      known.current.clear()
    }
    current.current = displayed
    changeRef.current = onChange
  })

  const publish = (display: string, markers: Marker[]) => {
    const parts: string[] = []
    let cursor = 0
    for (const marker of markers) {
      parts.push(display.slice(cursor, marker.start))
      cursor = marker.end
    }
    parts.push(display.slice(cursor))
    const body = parts.join('')
    const next = { body, display, markers }
    current.current = next
    setShadow(next)
    changeRef.current(body)
  }
  const change = (next: string) => {
    const previous = current.current
    if (next === previous.display) {
      const caret = before.current?.start ?? textarea.current?.selectionStart ?? next.length
      before.current = null
      return caret
    }
    if (!previous.markers.length && !known.current.size) {
      before.current = null
      publish(next, [])
      return textarea.current?.selectionStart ?? next.length
    }
    let start = 0
    while (start < previous.display.length && previous.display[start] === next[start]) {
      start++
    }
    if (before.current) {
      start = Math.min(start, before.current.start)
    }
    let suffix = 0
    while (
      suffix < previous.display.length - start &&
      suffix < next.length - start &&
      previous.display[previous.display.length - suffix - 1] === next[next.length - suffix - 1]
    ) {
      suffix++
    }
    if (before.current) {
      suffix = Math.min(suffix, previous.display.length - before.current.end)
    }
    before.current = null
    const end = previous.display.length - suffix
    const inserted = next.slice(start, next.length - suffix)
    const touched = previous.markers.filter(
      (marker) =>
        (start < marker.end && end > marker.start) ||
        (start === end && start > marker.start && start < marker.end)
    )
    const from = Math.min(start, ...touched.map((marker) => marker.start))
    const to = Math.max(end, ...touched.map((marker) => marker.end))
    const delta = inserted.length - (to - from)
    let display = previous.display.slice(0, from) + inserted + previous.display.slice(to)
    let markers = previous.markers
      .filter((marker) => !touched.includes(marker))
      .map((marker) =>
        marker.start >= to
          ? { ...marker, start: marker.start + delta, end: marker.end + delta }
          : marker
      )
    // Undo can restore labels after their range disappeared; only this draft's generated labels retire.
    const active = new Set(markers.map((marker) => marker.start))
    const removed: { start: number; length: number }[] = []
    display = display.replace(
      /!\[Uploading (?:\\.|[^\\[\]])*…\]\(\)/g,
      (token: string, offset: number) => {
        if (active.has(offset) || !known.current.has(token)) {
          return token
        }
        removed.push({ start: offset, length: token.length })
        return ''
      }
    )
    let shift = 0
    let index = 0
    markers = markers.map((marker) => {
      while (index < removed.length && removed[index].start < marker.start) {
        shift += removed[index++].length
      }
      return { ...marker, start: marker.start - shift, end: marker.end - shift }
    })
    publish(display, markers)
    return from + inserted.length
  }
  const receive = (files: File[], selection?: { start: number; end: number }) => {
    let caret =
      selection?.start ?? textarea.current?.selectionStart ?? current.current.display.length
    let end = selection?.end ?? textarea.current?.selectionEnd ?? caret
    return uploads.receive(files, (file) => {
      const id = createNonSecureContextUuid()
      const label = (file.name || 'image.png').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')
      const token = `![Uploading ${label}…]()`
      known.current.add(token)
      const previous = current.current
      before.current = { start: caret, end }
      caret = change(previous.display.slice(0, caret) + previous.display.slice(end))
      const clean = current.current
      const delta = token.length
      const marker = { start: caret, end: caret + delta, id }
      publish(
        clean.display.slice(0, caret) + token + clean.display.slice(caret),
        [
          ...clean.markers.map((entry) =>
            entry.start >= caret
              ? { ...entry, start: entry.start + delta, end: entry.end + delta }
              : entry
          ),
          marker
        ].sort((a, b) => a.start - b.start)
      )
      caret = marker.end
      end = caret
      const nextCaret = caret
      requestAnimationFrame(() => textarea.current?.setSelectionRange(nextCaret, nextCaret))
      return (url?: string) => {
        const latest = current.current
        const owned = latest.markers.find((entry) => entry.id === id)
        if (!owned) {
          return
        }
        const markdown = url
          ? `![${(file.name || 'image').replace(/[\\[\]]/g, '\\$&')}](<${url}>)`
          : ''
        const shift = markdown.length - (owned.end - owned.start)
        publish(
          latest.display.slice(0, owned.start) + markdown + latest.display.slice(owned.end),
          latest.markers
            .filter((entry) => entry !== owned)
            .map((entry) =>
              entry.start >= owned.end
                ? { ...entry, start: entry.start + shift, end: entry.end + shift }
                : entry
            )
        )
      }
    })
  }
  const events = useGitHubImageEvents(
    textarea,
    receive,
    () => {
      const node = textarea.current
      return node && document.activeElement === node
        ? { start: node.selectionStart, end: node.selectionEnd }
        : { start: current.current.display.length, end: current.current.display.length }
    },
    () => options.enabled !== false && !textarea.current?.disabled
  )
  return {
    value: displayed.display,
    change,
    attachDrop: events.attachDrop,
    pending: uploads.pending,
    onBeforeInput: (event: React.FormEvent<HTMLTextAreaElement>) => {
      before.current = {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd
      }
    },
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (events.paste(event)) {
        event.preventDefault()
      }
    }
  }
}
