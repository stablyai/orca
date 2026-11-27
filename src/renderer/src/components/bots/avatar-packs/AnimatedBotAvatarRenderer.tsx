import React, { useEffect, useId, useRef } from 'react'
import { avatarPackAssetUrl } from '../../../../../shared/avatar-pack-scheme'
import type { AvatarKeyframedAnimation, AvatarKeyframedNode } from './avatar-pack-types'

type FrameCallback = (now: number) => boolean

const activeFrames = new Set<FrameCallback>()
let sharedRafId: number | null = null

function tickSharedClock(now: number): void {
  sharedRafId = null
  for (const step of Array.from(activeFrames)) {
    if (!step(now)) {
      activeFrames.delete(step)
    }
  }
  if (activeFrames.size > 0 && typeof requestAnimationFrame === 'function') {
    sharedRafId = requestAnimationFrame(tickSharedClock)
  }
}

function addSharedFrameSubscriber(step: FrameCallback): void {
  activeFrames.add(step)
  if (sharedRafId === null && typeof requestAnimationFrame === 'function') {
    sharedRafId = requestAnimationFrame(tickSharedClock)
  }
}

function removeSharedFrameSubscriber(step: FrameCallback): void {
  activeFrames.delete(step)
  if (
    activeFrames.size === 0 &&
    sharedRafId !== null &&
    typeof cancelAnimationFrame === 'function'
  ) {
    cancelAnimationFrame(sharedRafId)
    sharedRafId = null
  }
}

let sharedObserver: IntersectionObserver | null = null
let sharedObserverCtor: typeof IntersectionObserver | undefined
const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>()

function observeVisibility(
  element: Element,
  onVisibilityChange: (visible: boolean) => void
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    return () => {}
  }
  if (!sharedObserver || sharedObserverCtor !== IntersectionObserver) {
    sharedObserverCtor = IntersectionObserver
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        visibilityListeners.get(entry.target)?.(entry.isIntersecting)
      }
    })
  }
  visibilityListeners.set(element, onVisibilityChange)
  sharedObserver.observe(element)
  return () => {
    visibilityListeners.delete(element)
    sharedObserver?.unobserve(element)
  }
}

function evaluateTrack(
  track: NonNullable<AvatarKeyframedNode['tracks']>[string],
  t: number
): number | string | number[] | null {
  const { times, values, discrete } = track
  if (!times || times.length === 0) {
    return null
  }
  if (times.length === 1 || t <= times[0]!) {
    return values[0] ?? null
  }
  if (t >= times.at(-1)!) {
    return values.at(-1) ?? null
  }

  let low = 0
  let high = times.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (times[mid]! <= t) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const i0 = Math.max(0, low - 1)
  const i1 = Math.min(times.length - 1, low)

  if (discrete || i0 === i1) {
    return values[i0] ?? null
  }

  const t0 = times[i0]!
  const t1 = times[i1]!
  const alpha = (t - t0) / (t1 - t0)
  const v0 = values[i0]
  const v1 = values[i1]

  if (Array.isArray(v0) && Array.isArray(v1)) {
    const res: number[] = []
    for (let k = 0; k < v0.length; k++) {
      const start = Number(v0[k]) || 0
      const end = Number(v1[k]) || 0
      res.push(start + alpha * (end - start))
    }
    return res
  }
  if (typeof v0 === 'number' && typeof v1 === 'number') {
    return v0 + alpha * (v1 - v0)
  }
  return v0 ?? null
}

function rewriteScopedAttribute(value: string, scopedIds: ReadonlyMap<string, string>): string {
  if (!value.includes('url(#')) {
    return value
  }
  return value.replace(/url\(#([^)]+)\)/g, (match, refId: string) => {
    const scoped = scopedIds.get(refId)
    return scoped ? `url(#${scoped})` : match
  })
}

export function AnimatedBotAvatarRenderer({
  animation,
  pack,
  className,
  style
}: {
  animation: AvatarKeyframedAnimation
  pack: string
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const rawScopeId = useId()
  const scopePrefix = `av-${rawScopeId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    container.innerHTML = ''
    const nodes = animation.nodes || []
    const svgNode = nodes.find((n) => n.tag === 'svg')
    if (!svgNode) {
      return
    }

    // Scope internal defs IDs so multiple inline SVGs never collide on #o0 / #f0.
    const scopedIds = new Map<string, string>()
    for (const n of nodes) {
      const rawId = n.attrs?.id
      if (rawId) {
        scopedIds.set(rawId, `${scopePrefix}-${rawId}`)
      }
    }

    const svgElem = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [k, v] of Object.entries(svgNode.attrs || {})) {
      svgElem.setAttribute(
        k,
        k === 'id' ? (scopedIds.get(v) ?? v) : rewriteScopedAttribute(v, scopedIds)
      )
    }
    if (animation.vb && Array.isArray(animation.vb)) {
      svgElem.setAttribute('viewBox', animation.vb.join(' '))
    }
    svgElem.style.width = '100%'
    svgElem.style.height = '100%'
    svgElem.style.overflow = 'visible'

    const nodeMap: Record<string, { elem: SVGElement; node: AvatarKeyframedNode }> = {
      [svgNode.id]: { elem: svgElem, node: svgNode }
    }

    for (const n of nodes) {
      if (n.tag === 'svg') {
        continue
      }
      const elem = document.createElementNS('http://www.w3.org/2000/svg', n.tag)
      for (const [k, v] of Object.entries(n.attrs || {})) {
        if (n.tag === 'image' && (k === 'href' || k === 'xlink:href')) {
          const texUrl = avatarPackAssetUrl(`packs/${pack}/textures/${v}`)
          elem.setAttributeNS('http://www.w3.org/1999/xlink', 'href', texUrl)
          elem.setAttribute('href', texUrl)
        } else if ((k === 'href' || k === 'xlink:href') && v.startsWith('#')) {
          const scopedRef = scopedIds.get(v.slice(1))
          elem.setAttribute(k, scopedRef ? `#${scopedRef}` : v)
        } else if (k === 'id') {
          elem.setAttribute(k, scopedIds.get(v) ?? v)
        } else {
          elem.setAttribute(k, rewriteScopedAttribute(v, scopedIds))
        }
      }
      nodeMap[n.id] = { elem, node: n }
    }

    for (const n of nodes) {
      if (n.tag === 'svg') {
        continue
      }
      const parentNode = nodeMap[n.parent || '']
      const currentElem = nodeMap[n.id]?.elem
      if (currentElem) {
        if (parentNode) {
          parentNode.elem.appendChild(currentElem)
        } else {
          svgElem.appendChild(currentElem)
        }
      }
    }

    container.appendChild(svgElem)

    const animatedNodes = Object.values(nodeMap).filter(
      (item) => item.node.tracks && Object.keys(item.node.tracks).length > 0
    )

    const renderFrame = (p: number): void => {
      for (const { elem, node } of animatedNodes) {
        const tracks = node.tracks
        if (!tracks) {
          continue
        }
        for (const [tname, track] of Object.entries(tracks)) {
          const val = evaluateTrack(track, p)
          if (val === null || val === undefined) {
            continue
          }

          if (tname === 'transform' && Array.isArray(val) && val.length === 6) {
            elem.setAttribute(
              'transform',
              `matrix(${val[0]?.toFixed(5)},${val[1]?.toFixed(5)},${val[2]?.toFixed(5)},${val[3]?.toFixed(5)},${val[4]?.toFixed(5)},${val[5]?.toFixed(5)})`
            )
          } else if (tname === 'opacity') {
            const op = Array.isArray(val) ? val[0] : val
            if (op !== undefined) {
              elem.setAttribute('opacity', typeof op === 'number' ? op.toFixed(4) : String(op))
            }
          } else if (tname === 'path') {
            elem.setAttribute('d', String(val))
          } else if (tname === 'present') {
            elem.style.display = val === '1' || val === 1 ? '' : 'none'
          } else if (tname === 'slope') {
            const slope = Array.isArray(val) ? val[0] : val
            if (slope !== undefined) {
              elem.setAttribute(
                'slope',
                typeof slope === 'number' ? slope.toFixed(4) : String(slope)
              )
            }
          } else if (tname === 'values') {
            const formatted = Array.isArray(val)
              ? val
                  .map((item) => (typeof item === 'number' ? item.toFixed(4) : String(item)))
                  .join(' ')
              : typeof val === 'number'
                ? val.toFixed(4)
                : String(val)
            elem.setAttribute('values', formatted)
          }
        }
      }
    }

    renderFrame(0)
    if (animatedNodes.length === 0) {
      return () => {
        container.innerHTML = ''
      }
    }

    const mediaQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    let reducedMotion = mediaQuery?.matches ?? false
    let isVisible = true
    let finishedOnce = false
    const duration = animation.duration || 1
    let startTime = performance.now()

    const stepFrame: FrameCallback = (now) => {
      if (reducedMotion || !isVisible) {
        return false
      }
      const elapsed = (now - startTime) / 1000
      const progress = animation.once
        ? Math.min(1, elapsed / duration)
        : (elapsed % duration) / duration

      renderFrame(progress)

      if (animation.once && progress >= 1) {
        finishedOnce = true
        return false
      }
      return true
    }

    const syncPlayback = (): void => {
      if (reducedMotion) {
        removeSharedFrameSubscriber(stepFrame)
        renderFrame(0)
        return
      }
      if (!isVisible || finishedOnce) {
        removeSharedFrameSubscriber(stepFrame)
        return
      }
      addSharedFrameSubscriber(stepFrame)
    }

    const handleMotionChange = (event: MediaQueryListEvent): void => {
      reducedMotion = event.matches
      if (!reducedMotion) {
        startTime = performance.now()
        finishedOnce = false
      }
      syncPlayback()
    }

    mediaQuery?.addEventListener('change', handleMotionChange)
    const unobserve = observeVisibility(container, (visible) => {
      isVisible = visible
      syncPlayback()
    })

    syncPlayback()

    return () => {
      removeSharedFrameSubscriber(stepFrame)
      mediaQuery?.removeEventListener('change', handleMotionChange)
      unobserve()
      container.innerHTML = ''
    }
  }, [animation, pack, scopePrefix])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        ...style
      }}
    />
  )
}
