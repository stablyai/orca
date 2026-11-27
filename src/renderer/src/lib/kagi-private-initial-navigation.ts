import { createKagiPrivateNavigationQueue } from '../../../shared/browser/navigation/kagi-private-navigation-queue'

const pending = createKagiPrivateNavigationQueue()
export const queueKagiPrivateInitialNavigation = pending.queue
export const takeKagiPrivateInitialNavigation = pending.take
export const discardKagiPrivateInitialNavigation = pending.discard
