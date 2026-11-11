import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-output/terminal-delivery-credit'
import { waitForTerminalReplayWritesParsed } from '../../snapshots/replay-guard'
import { flushTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { enforceTerminalCurrentScrollIntent } from '@/lib/pane-manager/terminal-scroll-intent'
import {
  MAX_DEFERRED_REATTACH_LIVE_CHARS,
  DeferredReattachLiveDataQueue
} from './deferred-reattach-live-data-queue'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindReattachLiveDataDeferral(session: ConnectPanePtySession): void {
  session.finishReattachLiveDataDeferral = (
    deliver: boolean,
    acceptedGeneration = session.transportStreamGeneration
  ): void => {
    if (session.reattachLiveDataDeferralDepth <= 0) {
      return
    }
    if (!deliver) {
      const owner = session.deferredReattachLiveDataOwners.get(acceptedGeneration)
      if (owner) {
        owner.failed = true
      }
    }
    session.reattachLiveDataDeferralDepth -= 1
    if (session.reattachLiveDataDeferralDepth > 0) {
      return
    }
    const queue = session.deferredReattachLiveData
    session.deferredReattachLiveData = null
    const currentPtyId = session.transport.getPtyId()
    const currentGeneration = session.transportStreamGeneration
    const currentOwner = session.deferredReattachLiveDataOwners.get(currentGeneration)
    session.deferredReattachLiveDataOwners = new Map()
    if (session.disposed || !queue) {
      queue?.discard()
      return
    }
    const chunks = queue.takeAll()
    // Why: paint the authoritative replay first, then admit deferred live chunks so the replay clear can't erase newer output.
    let deliveredDeferredChunks = 0
    for (const chunk of chunks) {
      if (
        chunk.ptyId !== currentPtyId ||
        chunk.streamGeneration !== currentGeneration ||
        currentOwner?.failed === true
      ) {
        chunk.ackCredit?.()
        continue
      }
      if (chunk.ackCredit) {
        deliverTerminalDataWithDeferredCredit(chunk.ackCredit, () => {
          session.dataCallback(chunk.data, chunk.meta, chunk.streamGeneration)
        })
      } else {
        session.dataCallback(chunk.data, chunk.meta, chunk.streamGeneration)
      }
      deliveredDeferredChunks += 1
    }
    if (deliveredDeferredChunks > 0) {
      // Why: replay restores the viewport before these newer bytes parse; settle the deferred slice, then apply the latest user intent.
      flushTerminalOutput(session.pane.terminal, { maxChars: MAX_DEFERRED_REATTACH_LIVE_CHARS })
      void waitForTerminalReplayWritesParsed(session.pane.terminal).then(() => {
        if (
          session.disposed ||
          !session.deps.isVisibleRef.current ||
          session.transport.getPtyId() !== currentPtyId ||
          session.transportStreamGeneration !== currentGeneration
        ) {
          return
        }
        enforceTerminalCurrentScrollIntent(session.pane.terminal)
      })
    }
  }
}

export function bindBeginReattachLiveDataDeferral(session: ConnectPanePtySession): void {
  session.beginReattachLiveDataDeferral = (
    ownerGeneration = session.transportStreamGeneration
  ): void => {
    session.reattachLiveDataDeferralDepth += 1
    if (session.reattachLiveDataDeferralDepth === 1) {
      session.deferredReattachLiveData = new DeferredReattachLiveDataQueue()
      session.deferredReattachLiveDataOwners = new Map()
    }
    if (!session.deferredReattachLiveDataOwners.has(ownerGeneration)) {
      session.deferredReattachLiveDataOwners.set(ownerGeneration, { failed: false })
    }
  }

  session.beginReattachLiveDataDeferralIfUnowned = (
    ownerGeneration = session.transportStreamGeneration
  ): void => {
    if (!session.deferredReattachLiveDataOwners.has(ownerGeneration)) {
      session.beginReattachLiveDataDeferral(ownerGeneration)
    }
  }
}
