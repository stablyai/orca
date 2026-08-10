import React from 'react'
import type { Swiper as SwiperInstance } from 'swiper'
import { Mousewheel } from 'swiper/modules'
import { Swiper, SwiperSlide } from 'swiper/react'
import 'swiper/css'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { useAppStore } from '@/store'
import WorktreeList from './WorktreeList'
import { registerSpaceTransitionHandler } from './space-transition-controller'

const SPACE_SWIPE_SPEED_MS = 180
// Why: the pinned slot has to outlive the CSS transition, not expire on the frame it finishes.
const SPACE_SWIPE_SETTLE_MS = 40
const SPACE_SLIDE_CLASS = '!flex !h-full !flex-col'

type SpaceSlideTravel = {
  id: number
  direction: 'next' | 'prev'
  /** Slots frozen on the Space they showed when the jump began, so nothing swaps mid-slide. */
  pinned: ReadonlyMap<number, string>
}

/**
 * Where the target sits in the strip, not the shorter way round the loop: a Space to the left
 * always enters from the left, so the slide matches the dot the user aimed at.
 */
function spaceSlideDirection(from: number, to: number): 'next' | 'prev' {
  return to < from ? 'prev' : 'next'
}

type SidebarSpacePagerProps = {
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  workspaceBoardOpen?: boolean
  onWorkspaceBoardDragPreviewStart?: () => void
  onWorkspaceBoardDragPreviewCommit?: () => void
  onWorkspaceBoardDragPreviewCancel?: () => void
}

/**
 * Swiper's slides are slots, not Spaces: slot `i` shows the Space `rotation` places further along
 * the list. Re-anchoring the rotation puts any Space next to the visible one, so switching to a
 * distant Space is one slide of the two Spaces involved rather than a trip past everything between.
 */
function SidebarSpacePager({
  scrollOffsetRef,
  scrollAnchorRef,
  ...listProps
}: SidebarSpacePagerProps): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces)
  const activeSpaceId = useAppStore((state) => state.activeSpaceId)
  const setActiveSpace = useAppStore((state) => state.setActiveSpace)
  const prefersReducedMotion = usePrefersReducedMotion()
  const swiperRef = React.useRef<SwiperInstance | null>(null)
  const travellingRef = React.useRef(false)
  const travelIdRef = React.useRef(0)
  const [rotation, setRotation] = React.useState(0)
  const [travel, setTravel] = React.useState<SpaceSlideTravel | null>(null)

  const count = spaces.length
  const activeIndex = Math.max(
    0,
    spaces.findIndex((space) => space.id === activeSpaceId)
  )
  // The visible slot is whichever one the rotation currently points at the active Space.
  const activeSlot = count === 0 ? 0 : (activeIndex - rotation + count) % count

  const latestRef = React.useRef({
    activeSpaceId,
    prefersReducedMotion,
    rotation,
    setActiveSpace,
    spaces,
    travel
  })
  latestRef.current = {
    activeSpaceId,
    prefersReducedMotion,
    rotation,
    setActiveSpace,
    spaces,
    travel
  }

  const slotSpaceIds = React.useMemo(
    () => getSlotSpaceIds(spaces, rotation, travel?.pinned),
    [rotation, spaces, travel]
  )
  const mountedSlots = React.useMemo(() => getMountedSlots(activeSlot, count), [activeSlot, count])
  const scrollStateBySpaceId = useSpaceScrollState(scrollOffsetRef, scrollAnchorRef, activeSpaceId)

  const handleActiveIndexChange = React.useCallback((swiper: SwiperInstance): void => {
    const latest = latestRef.current
    if (travellingRef.current || latest.spaces.length === 0) {
      return
    }
    const target = latest.spaces[(swiper.realIndex + latest.rotation) % latest.spaces.length]
    if (!target || target.id === latest.activeSpaceId) {
      return
    }
    latest.activeSpaceId = target.id
    latest.setActiveSpace(target.id)
  }, [])

  React.useLayoutEffect(() => {
    const swiper = swiperRef.current
    if (travel || !swiper || swiper.destroyed || swiper.realIndex === activeSlot) {
      return
    }
    swiper.slideToLoop(activeSlot, 0, false)
  }, [activeSlot, travel])

  React.useLayoutEffect(() => {
    if (!travel) {
      return
    }
    const settle = (): void => {
      travellingRef.current = false
      setTravel((current) => (current?.id === travel.id ? null : current))
    }
    const swiper = swiperRef.current
    if (!swiper || swiper.destroyed) {
      settle()
      return
    }
    if (travel.direction === 'next') {
      swiper.slideNext(SPACE_SWIPE_SPEED_MS)
    } else {
      swiper.slidePrev(SPACE_SWIPE_SPEED_MS)
    }
    const timer = setTimeout(settle, SPACE_SWIPE_SPEED_MS + SPACE_SWIPE_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [travel])

  React.useEffect(
    () =>
      registerSpaceTransitionHandler((spaceId) => {
        const swiper = swiperRef.current
        const latest = latestRef.current
        const total = latest.spaces.length
        const targetIndex = latest.spaces.findIndex((space) => space.id === spaceId)
        // Why: reduced motion has nothing to animate, so let the caller switch and the sync effect cut.
        if (!swiper || swiper.destroyed || total < 2 || latest.prefersReducedMotion) {
          return false
        }
        const slot = swiper.realIndex % total
        const fromIndex = (slot + latest.rotation) % total
        if (targetIndex < 0 || targetIndex === fromIndex) {
          return false
        }
        const direction = spaceSlideDirection(fromIndex, targetIndex)
        const destination = (slot + (direction === 'next' ? 1 : -1) + total) % total
        // Why: pins from earlier hops outlive their own slide, so a chain has to release the two
        // that would fight this one — the slot being slid into, and whoever still holds the target.
        const pinned = new Map(latest.travel?.pinned)
        pinned.delete(destination)
        for (const [heldSlot, heldId] of pinned) {
          if (heldId === spaceId) {
            pinned.delete(heldSlot)
          }
        }
        pinned.set(slot, latest.spaces[fromIndex].id)
        travellingRef.current = true
        // Anchor the rotation so the slide being swiped into already holds the target Space.
        setRotation((targetIndex - destination + total) % total)
        setTravel({ direction, id: (travelIdRef.current += 1), pinned })
        latest.activeSpaceId = spaceId
        latest.setActiveSpace(spaceId)
        return true
      }),
    []
  )

  return (
    <Swiper
      modules={[Mousewheel]}
      className="min-h-0 w-full flex-1 overscroll-x-contain"
      direction="horizontal"
      loop={count > 1}
      slidesPerView={1}
      slidesPerGroup={1}
      initialSlide={activeSlot}
      speed={prefersReducedMotion ? 0 : SPACE_SWIPE_SPEED_MS}
      simulateTouch={false}
      loopPreventsSliding={false}
      resistanceRatio={0.35}
      mousewheel={{ forceToAxis: true, thresholdDelta: 6 }}
      onSwiper={(swiper) => {
        swiperRef.current = swiper
      }}
      onActiveIndexChange={handleActiveIndexChange}
      onDestroy={() => {
        swiperRef.current = null
      }}
    >
      {spaces.map((slotSpace, slot) => {
        const spaceId = slotSpaceIds[slot]
        const mounted = mountedSlots.has(slot) || travel?.pinned.has(slot) === true
        if (spaceId === null || !mounted) {
          return <SwiperSlide key={slotSpace.id} className={SPACE_SLIDE_CLASS} />
        }
        const active = spaceId === activeSpaceId
        const scroll = scrollStateBySpaceId(spaceId)
        return (
          <SwiperSlide key={slotSpace.id} className={SPACE_SLIDE_CLASS}>
            <WorktreeList
              key={spaceId}
              spaceId={spaceId}
              inert={!active}
              scrollOffsetRef={scroll.offsetRef}
              scrollAnchorRef={scroll.anchorRef}
              {...(active ? listProps : {})}
            />
          </SwiperSlide>
        )
      })}
    </Swiper>
  )
}

/** Null where a slot has nothing of its own to show, because a pin is holding its Space elsewhere. */
function getSlotSpaceIds(
  spaces: readonly { id: string }[],
  rotation: number,
  pinned: ReadonlyMap<number, string> | undefined
): (string | null)[] {
  const known = new Set(spaces.map((space) => space.id))
  const held = new Set(Array.from(pinned?.values() ?? []).filter((id) => known.has(id)))
  return spaces.map((_, slot) => {
    const pinnedId = pinned?.get(slot)
    if (pinnedId !== undefined && known.has(pinnedId)) {
      return pinnedId
    }
    // Why: a full-length hop rotates the outgoing Space onto a second slot while its pin still holds it.
    const rotated = spaces[(slot + rotation) % spaces.length].id
    return held.has(rotated) ? null : rotated
  })
}

function getMountedSlots(activeSlot: number, count: number): Set<number> {
  if (count <= 3) {
    return new Set(spaceSlotRange(count))
  }
  return new Set([activeSlot, (activeSlot - 1 + count) % count, (activeSlot + 1) % count])
}

function spaceSlotRange(count: number): number[] {
  return Array.from({ length: count }, (_, slot) => slot)
}

function useSpaceScrollState(
  scrollOffsetRef: React.MutableRefObject<number>,
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>,
  activeSpaceId: string
): (spaceId: string) => {
  offsetRef: React.MutableRefObject<number>
  anchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
} {
  const bySpaceId = React.useRef(
    new Map<
      string,
      {
        offsetRef: React.MutableRefObject<number>
        anchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
      }
    >()
  )

  return React.useCallback(
    (spaceId: string) => {
      if (spaceId === activeSpaceId) {
        return { offsetRef: scrollOffsetRef, anchorRef: scrollAnchorRef }
      }
      const existing = bySpaceId.current.get(spaceId)
      if (existing) {
        return existing
      }
      const created = { offsetRef: { current: 0 }, anchorRef: { current: null } }
      bySpaceId.current.set(spaceId, created)
      return created
    },
    [activeSpaceId, scrollAnchorRef, scrollOffsetRef]
  )
}

export default React.memo(SidebarSpacePager)
