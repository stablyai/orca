import { useEffect, useLayoutEffect, useRef } from 'react'
import { reportPluginPanelDraw } from './plugin-panel-draw-status'
import type { PluginFrameElement } from './plugin-frame-element'

/** A components panel: drawn once a tree from the current guest is on screen. */
export function useReportDeclarativePanelDraw(
  tabKey: string,
  guestUrl: string,
  renderedDocument: string | null,
  issue: { message: string } | null
): void {
  // What showed when this guest arrived: a dev save keeps the last good tree until it renders.
  const baseline = useRef<{ document: string | null; issue: object | null }>({
    document: null,
    issue: null
  })
  const latest = useRef({ renderedDocument, issue })
  useLayoutEffect(() => {
    latest.current = { renderedDocument, issue }
  })
  useLayoutEffect(() => {
    baseline.current = {
      document: latest.current.renderedDocument,
      issue: latest.current.issue
    }
  }, [guestUrl])
  useEffect(() => {
    // Why identity: a banner left over from the replaced guest says nothing about this one.
    const freshIssue = issue !== null && issue !== baseline.current.issue
    const freshTree = renderedDocument !== null && renderedDocument !== baseline.current.document
    reportPluginPanelDraw(tabKey, {
      ui: 'components',
      guestUrl,
      drawn: freshTree || freshIssue,
      issue: issue?.message ?? null,
      failure: null
    })
  }, [tabKey, guestUrl, renderedDocument, issue])
  useEffect(() => () => reportPluginPanelDraw(tabKey, null), [tabKey])
}

/** An html panel's guest: drawn once its document finished loading. */
export function useReportFramePanelDraw(
  tabKey: string,
  frameRef: React.RefObject<PluginFrameElement | null>,
  guestUrl: string | null
): void {
  useEffect(() => {
    if (guestUrl === null) {
      return
    }
    const frame = frameRef.current
    const report = (drawn: boolean): void =>
      reportPluginPanelDraw(tabKey, { ui: 'html', guestUrl, drawn, issue: null, failure: null })
    report(false)
    const onLoaded = (): void => report(true)
    frame?.addEventListener('did-finish-load', onLoaded)
    return () => {
      frame?.removeEventListener('did-finish-load', onLoaded)
      reportPluginPanelDraw(tabKey, null)
    }
  }, [frameRef, guestUrl, tabKey])
}

/** A panel that cannot draw (load failed, suspended) settles a waiting capture at once. */
export function reportPluginPanelFailure(tabKey: string, failure: string): void {
  reportPluginPanelDraw(tabKey, { ui: 'html', guestUrl: null, drawn: false, issue: null, failure })
}
