import type { Page } from '@stablyai/playwright-test'

// Freeze the oracle only after the fixture's reveal and measured rows have settled.
export async function waitForLineageScrollFixtureReady(
  page: Page,
  parentId: string
): Promise<void> {
  await page.evaluate(
    (parentId) =>
      new Promise<void>((resolve, reject) => {
        const sidebar = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
        if (!sidebar) {
          reject(new Error('Missing sidebar'))
          return
        }
        const quietSpanMs = 500
        const started = performance.now()
        let lastScrollAt = started
        let unchangedSince = started
        let signature = ''
        let frameId: number | null = null
        let frames = 0
        let intervalId: ReturnType<typeof setInterval> | undefined
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const cleanup = (): void => {
          sidebar.removeEventListener('scroll', onScroll)
          window.removeEventListener('pagehide', onPageHide)
          clearInterval(intervalId)
          clearTimeout(timeoutId)
          if (frameId !== null) {
            cancelAnimationFrame(frameId)
          }
        }
        const finish = (error?: Error): void => {
          cleanup()
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }
        const onScroll = (): void => {
          lastScrollAt = performance.now()
        }
        const onPageHide = (): void => finish(new Error('Renderer closed before fixture settled'))
        const readSignature = (): string => {
          const parent = sidebar.querySelector<HTMLElement>(
            `[role="option"][data-worktree-id=${JSON.stringify(parentId)}]`
          )
          const wrapper = parent?.closest<HTMLElement>('[data-worktree-virtual-row]')
          if (
            !parent?.isConnected ||
            !wrapper ||
            document.fonts.status !== 'loaded' ||
            sidebar.scrollTop <= 0
          ) {
            return ''
          }
          const mounted = Array.from(
            sidebar.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]')
          )
          if (mounted.length > 100) {
            throw new Error('Unbounded lineage fixture row measurement')
          }
          const parentRect = parent.getBoundingClientRect()
          const sidebarRect = sidebar.getBoundingClientRect()
          return JSON.stringify({
            id: parent.dataset.worktreeId,
            key: wrapper.dataset.worktreeVirtualRowKey,
            index: wrapper.dataset.index,
            start: wrapper.dataset.worktreeVirtualRowStart,
            transform: wrapper.style.transform,
            parentTop: parentRect.top,
            parentHeight: parentRect.height,
            scrollTop: sidebar.scrollTop,
            scrollHeight: sidebar.scrollHeight,
            sidebarTop: sidebarRect.top,
            sidebarHeight: sidebarRect.height,
            canvasHeight: wrapper.parentElement?.style.height,
            rows: mounted.map((row) => ({
              key: row.dataset.worktreeVirtualRowKey,
              index: row.dataset.index,
              start: row.dataset.worktreeVirtualRowStart,
              transform: row.style.transform,
              height: row.getBoundingClientRect().height
            }))
          })
        }
        const inspect = (): boolean => {
          const next = readSignature()
          if (!next || next !== signature) {
            signature = next
            unchangedSince = performance.now()
            frames = 0
            if (frameId !== null) {
              cancelAnimationFrame(frameId)
            }
            frameId = null
            return false
          }
          const now = performance.now()
          const ready = now - unchangedSince >= quietSpanMs && now - lastScrollAt >= quietSpanMs
          if (!ready) {
            frames = 0
          }
          return ready
        }
        const onFrame = (): void => {
          frameId = null
          try {
            if (!inspect()) {
              return
            }
            frames += 1
            if (frames === 2) {
              finish()
              return
            }
            frameId = requestAnimationFrame(onFrame)
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        }
        sidebar.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('pagehide', onPageHide, { once: true })
        intervalId = setInterval(() => {
          try {
            if (inspect() && frameId === null) {
              frameId = requestAnimationFrame(onFrame)
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        }, 50)
        timeoutId = setTimeout(
          () => finish(new Error(`Lineage fixture did not settle: ${signature}`)),
          10000
        )
      }),
    parentId
  )
}
