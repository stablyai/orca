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

type SidebarSpacePagerProps = {
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  workspaceBoardOpen?: boolean
  onWorkspaceBoardDragPreviewStart?: () => void
  onWorkspaceBoardDragPreviewCommit?: () => void
  onWorkspaceBoardDragPreviewCancel?: () => void
}

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
  const touchGestureStartIndexRef = React.useRef<number | null>(null)
  const latestRef = React.useRef({ activeSpaceId, prefersReducedMotion, setActiveSpace, spaces })
  latestRef.current = { activeSpaceId, prefersReducedMotion, setActiveSpace, spaces }

  const activeIndex = Math.max(
    0,
    spaces.findIndex((space) => space.id === activeSpaceId)
  )
  const mountedSpaceIds = React.useMemo(
    () =>
      new Set(spaces.slice(Math.max(0, activeIndex - 1), activeIndex + 2).map((space) => space.id)),
    [activeIndex, spaces]
  )
  const scrollStateBySpaceId = useSpaceScrollState(scrollOffsetRef, scrollAnchorRef, activeSpaceId)

  const handleActiveIndexChange = React.useCallback((swiper: SwiperInstance): void => {
    const latest = latestRef.current
    const gestureStartIndex = touchGestureStartIndexRef.current
    const limitedIndex =
      gestureStartIndex === null
        ? swiper.activeIndex
        : Math.max(gestureStartIndex - 1, Math.min(gestureStartIndex + 1, swiper.activeIndex))
    if (limitedIndex !== swiper.activeIndex) {
      swiper.slideTo(limitedIndex, latest.prefersReducedMotion ? 0 : SPACE_SWIPE_SPEED_MS, false)
    }
    const target = latest.spaces[limitedIndex]
    if (!target || target.id === latest.activeSpaceId) {
      return
    }
    latest.activeSpaceId = target.id
    latest.setActiveSpace(target.id)
  }, [])

  React.useLayoutEffect(() => {
    const swiper = swiperRef.current
    if (swiper && !swiper.destroyed && swiper.activeIndex !== activeIndex) {
      swiper.slideTo(activeIndex, 0, false)
    }
  }, [activeIndex])

  React.useEffect(
    () =>
      registerSpaceTransitionHandler((spaceId) => {
        const swiper = swiperRef.current
        const latest = latestRef.current
        const targetIndex = latest.spaces.findIndex((space) => space.id === spaceId)
        if (!swiper || swiper.destroyed || targetIndex < 0 || targetIndex === swiper.activeIndex) {
          return false
        }
        const adjacent = Math.abs(targetIndex - swiper.activeIndex) === 1
        swiper.slideTo(
          targetIndex,
          adjacent && !latest.prefersReducedMotion ? SPACE_SWIPE_SPEED_MS : 0
        )
        return true
      }),
    []
  )

  return (
    <Swiper
      modules={[Mousewheel]}
      className="min-h-0 w-full flex-1 overscroll-x-contain"
      direction="horizontal"
      slidesPerView={1}
      slidesPerGroup={1}
      initialSlide={activeIndex}
      speed={prefersReducedMotion ? 0 : SPACE_SWIPE_SPEED_MS}
      simulateTouch={false}
      resistanceRatio={0.35}
      mousewheel={{ forceToAxis: true, releaseOnEdges: true, thresholdDelta: 6 }}
      onTouchStart={(swiper) => {
        touchGestureStartIndexRef.current = swiper.activeIndex
      }}
      onTouchEnd={() => {
        queueMicrotask(() => {
          touchGestureStartIndexRef.current = null
        })
      }}
      onSwiper={(swiper) => {
        swiperRef.current = swiper
      }}
      onActiveIndexChange={handleActiveIndexChange}
      onDestroy={() => {
        swiperRef.current = null
      }}
    >
      {spaces.map((space) => {
        const active = space.id === activeSpaceId
        const mounted = active || mountedSpaceIds.has(space.id)
        const scroll = scrollStateBySpaceId(space.id)
        return (
          <SwiperSlide key={space.id} className="!flex !h-full !flex-col">
            {mounted ? (
              <WorktreeList
                spaceId={space.id}
                inert={!active}
                scrollOffsetRef={scroll.offsetRef}
                scrollAnchorRef={scroll.anchorRef}
                {...(active ? listProps : {})}
              />
            ) : null}
          </SwiperSlide>
        )
      })}
    </Swiper>
  )
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
