import type { PreloadApi } from '../../../../preload/api-types'
import { noopUnsubscribe } from './web-storage'

export function createWebAgentStatusApi(): Partial<PreloadApi> {
  return {
    agentStatus: {
      onSet: () => noopUnsubscribe,
      onClear: () => noopUnsubscribe,
      getSnapshot: () => Promise.resolve([]),
      inferInterrupt: () => Promise.resolve(false),
      inferQuestionAnswered: () => Promise.resolve(false),
      onMigrationUnsupported: () => noopUnsubscribe,
      onMigrationUnsupportedClear: () => noopUnsubscribe,
      onLegacyWorkerTerminalRecovery: () => noopUnsubscribe,
      getMigrationUnsupportedSnapshot: () => Promise.resolve([]),
      drop: () => {},
      reconcileEndedProcess: () => {},
      dropByTabPrefix: () => {},
      retirePaneAuthority: () => {},
      restorePaneAuthority: () => {},
      transferPaneAuthority: () => {}
    }
  }
}
