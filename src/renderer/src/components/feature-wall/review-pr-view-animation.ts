import { useEffect } from 'react'
import type { RefObject } from 'react'
import { translate } from '@/i18n/i18n'

function getReviewPrAnimatedStatusCopy(): {
  pendingLabel: string
  verifyLabel: string
  runningLabel: string
  checksPassedLabel: string
  checksCountLabel: string
  passedLabel: string
} {
  return {
    pendingLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.9a097cae12',
      '1 pending'
    ),
    verifyLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.d340c052fb',
      'verify'
    ),
    runningLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.8ed213397c',
      'Running'
    ),
    checksPassedLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.a6c8b9e32f',
      'Checks passed'
    ),
    checksCountLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.f4d5e1a7b2',
      '3 checks'
    ),
    passedLabel: translate(
      'auto.components.feature.wall.ReviewPRViewAnimatedVisual.ca36f7b27c',
      'Passed'
    )
  }
}

function moveCursor(
  root: HTMLElement,
  cursor: HTMLElement,
  anchor: HTMLElement,
  ox = 0,
  oy = 0
): void {
  const rootRect = root.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  cursor.style.transform = `translate(${anchorRect.left - rootRect.left + ox}px, ${
    anchorRect.top - rootRect.top + oy
  }px)`
}

export function useReviewPrViewAnimation(
  rootRef: RefObject<HTMLDivElement | null>,
  reducedMotion: boolean
): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }

    const sidebarPeek = root.querySelector<HTMLDivElement>('[data-checks-sidebar-peek]')
    const prCard = root.querySelector<HTMLDivElement>('[data-pr-view-card]')
    const cursor = root.querySelector<HTMLDivElement>('[data-cursor]')
    const explorerTab = root.querySelector<HTMLSpanElement>('[data-explorer-tab]')
    const checksTab = root.querySelector<HTMLSpanElement>('[data-checks-tab]')
    const checksTooltip = root.querySelector<HTMLSpanElement>('[data-checks-tooltip]')
    const checksBlock = root.querySelector<HTMLDivElement>('[data-checks-block]')
    const commentsBlock = root.querySelector<HTMLDivElement>('[data-comments-block]')
    const comments = Array.from(root.querySelectorAll<HTMLDivElement>('[data-comment-card]'))
    const commentsCount = root.querySelector<HTMLSpanElement>('[data-comments-count]')
    const checkSummary = root.querySelector<HTMLDivElement>('[data-check-summary]')
    const checkSummaryLabel = root.querySelector<HTMLSpanElement>('[data-check-summary-label]')
    const checkSummaryMeta = root.querySelector<HTMLSpanElement>('[data-check-summary-meta]')
    const verifyRow = root.querySelector<HTMLDivElement>('[data-check-row="verify"]')
    const verifyState = root.querySelector<HTMLSpanElement>('[data-check-verify-state]')
    const mergeBtn = root.querySelector<HTMLButtonElement>('[data-merge-btn]')
    if (
      !sidebarPeek ||
      !prCard ||
      !cursor ||
      !explorerTab ||
      !checksTab ||
      !checksTooltip ||
      !checksBlock ||
      !commentsBlock ||
      !commentsCount ||
      !checkSummary ||
      !checkSummaryLabel ||
      !checkSummaryMeta ||
      !verifyRow ||
      !verifyState ||
      !mergeBtn
    ) {
      return
    }

    const rootEl: HTMLDivElement = root
    const sidebarPeekEl: HTMLDivElement = sidebarPeek
    const prCardEl: HTMLDivElement = prCard
    const cursorEl: HTMLDivElement = cursor
    const explorerTabEl: HTMLSpanElement = explorerTab
    const checksTabEl: HTMLSpanElement = checksTab
    const checksTooltipEl: HTMLSpanElement = checksTooltip
    const checksBlockEl: HTMLDivElement = checksBlock
    const commentsBlockEl: HTMLDivElement = commentsBlock
    const commentsCountEl: HTMLSpanElement = commentsCount
    const checkSummaryEl: HTMLDivElement = checkSummary
    const checkSummaryLabelEl: HTMLSpanElement = checkSummaryLabel
    const checkSummaryMetaEl: HTMLSpanElement = checkSummaryMeta
    const verifyRowEl: HTMLDivElement = verifyRow
    const verifyStateEl: HTMLSpanElement = verifyState
    const mergeBtnEl: HTMLButtonElement = mergeBtn

    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timers.push(id)
      })

    function resetState(): void {
      sidebarPeekEl.classList.add('is-visible')
      sidebarPeekEl.classList.remove('is-hiding')
      prCardEl.classList.remove('is-visible')
      explorerTabEl.classList.add('is-active')
      checksTabEl.classList.remove('is-active', 'is-hovered')
      checksTooltipEl.classList.remove('is-visible')
      cursorEl.classList.remove('is-visible', 'is-clicking')
      cursorEl.style.transition = 'none'
      cursorEl.style.transform = 'translate(-30px, 220px)'
      void cursorEl.offsetWidth
      cursorEl.style.transition = ''
      checksBlockEl.classList.remove('is-visible')
      commentsBlockEl.classList.remove('is-visible')
      comments.forEach((el) => el.classList.remove('is-visible'))
      commentsCountEl.textContent = '0'
      checkSummaryEl.classList.remove('is-done')
      const copy = getReviewPrAnimatedStatusCopy()
      checkSummaryLabelEl.textContent = copy.pendingLabel
      checkSummaryMetaEl.textContent = copy.verifyLabel
      verifyRowEl.classList.remove('is-done')
      verifyStateEl.textContent = copy.runningLabel
      mergeBtnEl.classList.remove('is-ready')
    }

    function showFinalState(): void {
      resetState()
      sidebarPeekEl.classList.add('is-hiding')
      prCardEl.classList.add('is-visible')
      checksBlockEl.classList.add('is-visible')
      commentsBlockEl.classList.add('is-visible')
      comments.forEach((el) => el.classList.add('is-visible'))
      commentsCountEl.textContent = String(comments.length)
      checkSummaryEl.classList.add('is-done')
      const copy = getReviewPrAnimatedStatusCopy()
      checkSummaryLabelEl.textContent = copy.checksPassedLabel
      checkSummaryMetaEl.textContent = copy.checksCountLabel
      verifyRowEl.classList.add('is-done')
      verifyStateEl.textContent = copy.passedLabel
      mergeBtnEl.classList.add('is-ready')
      cursorEl.classList.remove('is-visible')
    }

    if (reducedMotion) {
      showFinalState()
      return
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        resetState()
        await wait(420)
        if (cancelled) {
          return
        }

        cursorEl.classList.add('is-visible')
        moveCursor(rootEl, cursorEl, checksTabEl, 5, 6)
        checksTabEl.classList.add('is-hovered')
        await wait(260)
        if (cancelled) {
          return
        }
        checksTooltipEl.classList.add('is-visible')
        await wait(1300)
        if (cancelled) {
          return
        }

        cursorEl.classList.add('is-clicking')
        await wait(220)
        if (cancelled) {
          return
        }
        cursorEl.classList.remove('is-clicking')
        checksTooltipEl.classList.remove('is-visible')
        checksTabEl.classList.remove('is-hovered')
        explorerTabEl.classList.remove('is-active')
        checksTabEl.classList.add('is-active')
        await wait(420)
        if (cancelled) {
          return
        }

        sidebarPeekEl.classList.add('is-hiding')
        prCardEl.classList.add('is-visible')
        cursorEl.classList.remove('is-visible')
        await wait(560)
        if (cancelled) {
          return
        }

        checksBlockEl.classList.add('is-visible')
        await wait(1050)
        if (cancelled) {
          return
        }

        verifyRowEl.classList.add('is-done')
        const copy = getReviewPrAnimatedStatusCopy()
        verifyStateEl.textContent = copy.passedLabel
        checkSummaryEl.classList.add('is-done')
        checkSummaryLabelEl.textContent = copy.checksPassedLabel
        checkSummaryMetaEl.textContent = copy.checksCountLabel
        mergeBtnEl.classList.add('is-ready')

        await wait(560)
        if (cancelled) {
          return
        }
        commentsBlockEl.classList.add('is-visible')
        await wait(260)
        if (cancelled) {
          return
        }

        for (let i = 0; i < comments.length; i++) {
          comments[i]?.classList.add('is-visible')
          commentsCountEl.textContent = String(i + 1)
          await wait(520)
          if (cancelled) {
            return
          }
        }

        await wait(2900)
      }
    }

    void loop()
    return () => {
      cancelled = true
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [reducedMotion, rootRef])
}
