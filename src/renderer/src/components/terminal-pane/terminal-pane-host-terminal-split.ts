import { toast } from 'sonner'
import { z } from 'zod'
import {
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import { resolveHostTerminalRoute } from '@/lib/terminal-worktree-route'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import type { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'

// Why unknown-first: the reply is wire data; only a non-blank string handle names a pane we can adopt.
const SplitReply = z.object({
  split: z.object({ handle: z.string().refine((h) => h.trim() !== '') })
})
const SPLIT_REFUSED = "Could not confirm this terminal's host, so it was not split."

/** Splits a host-stamped terminal on its target; false only for an unstamped tab, so refusals never fall through. */
export function splitHostTerminalPane(
  args: Parameters<typeof splitTerminalPaneWithInheritedCwd>[0]
): boolean {
  const getSourcePtyId = () => args.paneTransports.get(args.pane.id)?.getPtyId() ?? null
  const getManager = () => (args.getManager ? args.getManager() : args.manager)
  const requestManager = getManager()
  const sourcePtyId = getSourcePtyId()
  const resolveRoute = () =>
    resolveHostTerminalRoute(useAppStore.getState(), args.worktreeId, args.tabId, [sourcePtyId])
  const route = resolveRoute()
  if (!route) {
    return false
  }
  const owner = sourcePtyId ? parseRemoteRuntimePtyId(sourcePtyId) : null
  if (
    route.kind === 'refused' ||
    !owner?.handle.trim() ||
    owner.environmentId !== route.environmentId
  ) {
    toast.error(SPLIT_REFUSED)
    return true
  }
  const target = { kind: 'environment' as const, environmentId: route.environmentId }
  // Why once: a retry after an unknown outcome could leave two remote panes.
  void callRuntimeRpc<unknown>(target, 'terminal.split', {
    terminal: owner.handle,
    direction: args.direction,
    telemetrySource: args.source
  })
    .then((reply) => {
      const parsed = SplitReply.safeParse(reply)
      // Why: without a new valid handle there is no child we can positively name, so nothing is
      // adopted or closed; an echoed source handle would hit the original pane.
      if (!parsed.success || parsed.data.split.handle.trim() === owner.handle.trim()) {
        toast.error(SPLIT_REFUSED)
        return
      }
      const { handle } = parsed.data.split
      const manager = getManager()
      // Why: adopt only into the same live manager, pane, PTY and host/setup/selector route.
      const createdPane =
        manager &&
        manager === requestManager &&
        manager.getPanes().some((pane) => pane.id === args.pane.id) &&
        getSourcePtyId() === sourcePtyId &&
        JSON.stringify(resolveRoute()) === JSON.stringify(route)
          ? manager.splitPane(args.pane.id, args.direction, {
              ptyId: toRemoteRuntimePtyId(handle, target.environmentId)
            })
          : null
      if (!recordCreatedTerminalPaneSplit(createdPane, args)) {
        // Best effort: close only the child this call created.
        void callRuntimeRpc(target, 'terminal.close', { terminal: handle }).catch(() => {})
      }
    })
    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : SPLIT_REFUSED))
  return true
}
