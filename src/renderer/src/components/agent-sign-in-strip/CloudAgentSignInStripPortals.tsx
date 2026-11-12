// Orca Cloud panes get the strip instead of #40228's centred card: account recovery (S4-c) while the
// private launch hold waits, or #40228's per-workspace gate while the Orca-account path is paused or
// never offered. It overlays the top 56 px of the pane while the agent hasn't started, so the
// terminal's size never changes. SSH, WSL and paired hosts keep #40228's card.
import React, { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  readAgentSignInGate,
  subscribeAgentSignInGates
} from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import { abandonAgentSignIn } from '@/lib/agent-sign-in/agent-sign-in-gate'
import {
  cloudTabHoldKey,
  readCloudAgentHold,
  releaseCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { CloudAgentSignInStrip, cloudStripWidth } from './CloudAgentSignInStrip'
import { CloudPaneBannerPortal } from './CloudPaneBannerPortal'
import { useCloudHeldStrip } from './use-cloud-held-strip'
import { CloudRunningStripPortal } from './CloudRunningStripPortal'

const ABANDON_CHECK_MS = 1_000

/**
 * NOACCT-MISLABEL: a held launch is given up only when its tab is really gone (closed). A pane that
 * unmounts because its workspace is off screen (parked, another workspace, Settings) keeps waiting:
 * its strip and the sidebar mark come back with it. Cancelling it there showed "The agent didn't
 * start" for a create whose agent simply isn't set up.
 */
export function shouldAbandonCloudHold(args: {
  paneConnected: boolean
  tabOpen: boolean
}): boolean {
  return !args.paneConnected && !args.tabOpen
}

function isTabOpen(tabId: string): boolean {
  const tabsByWorktree = useAppStore.getState().tabsByWorktree
  return Object.values(tabsByWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

export { isOrcaCloudEnvironmentId }

/** Pane keys whose #40228 gate is on an Orca Cloud host; those panes show the strip instead. */
export function useCloudGatePaneKeys(controller: TerminalPaneController): ReadonlySet<string> {
  const joined = useSyncExternalStore(subscribeAgentSignInGates, () =>
    controller.managedPanes
      .map((pane) => makePaneKey(controller.tabId, pane.leafId))
      .filter((key) => {
        const gate = readAgentSignInGate(key)
        return gate !== null && isOrcaCloudEnvironmentId(gate.environmentId)
      })
      .join('\u0000')
  )
  return new Set(joined ? joined.split('\u0000') : [])
}

function CloudStripPortal({
  pane,
  tabId,
  first
}: {
  pane: ManagedPane
  tabId: string
  /** A host-published launch holds its whole tab (RA-1); its first pane shows the strip. */
  first: boolean
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const { key, active, strip } = useCloudHeldStrip(paneKey, first ? cloudTabHoldKey(tabId) : null)
  // The first render's class; the strip then follows its own live width (RA-1).
  const width = cloudStripWidth(pane.container.clientWidth)
  useEffect(() => {
    if (!active) {
      return
    }
    // A remount unmounts the portal too; only a pane that stays gone gives up its sign-in.
    return () => {
      setTimeout(() => {
        if (!pane.container.isConnected) {
          if (
            readCloudAgentHold(key) &&
            shouldAbandonCloudHold({ paneConnected: false, tabOpen: isTabOpen(tabId) })
          ) {
            releaseCloudAgentHold(key, 'cancel')
          }
          if (readAgentSignInGate(paneKey)) {
            abandonAgentSignIn(paneKey)
          }
        }
      }, ABANDON_CHECK_MS)
    }
  }, [active, key, paneKey, pane.container, tabId])
  if (!strip) {
    return null
  }
  return (
    <CloudPaneBannerPortal
      pane={pane}
      paneKey={paneKey}
      portalKey={`cloud-sign-in-strip-${pane.id}`}
      stripLayer
    >
      <CloudAgentSignInStrip {...strip} width={width} />
    </CloudPaneBannerPortal>
  )
}

export function CloudAgentSignInStripPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  return (
    <>
      {controller.managedPanes.map((pane, index) => (
        <React.Fragment key={pane.id}>
          <CloudStripPortal pane={pane} tabId={controller.tabId} first={index === 0} />
          <CloudRunningStripPortal
            pane={pane}
            tabId={controller.tabId}
            worktreeId={controller.worktreeId}
          />
        </React.Fragment>
      ))}
    </>
  )
}
