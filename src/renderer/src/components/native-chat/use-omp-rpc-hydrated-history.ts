// The pane's drained OMP RPC history snapshot, published by the
// TerminalPane-anchored ownership hook into the turn state. Non-null only once
// a WHOLE snapshot landed (drainOmpRpcHistory never reports a partial walk), so
// its presence doubles as proof that nothing older exists to page in.

import { useAppStore } from '../../store'
import type { OmpRpcHydratedHistory } from './omp-rpc-turn-reducer'

export function useOmpRpcHydratedHistory(paneKey: string): OmpRpcHydratedHistory | null {
  return useAppStore(
    (s) => s.ompRpcChatOwnershipByPaneKey[paneKey]?.turnState?.hydratedHistory ?? null
  )
}
