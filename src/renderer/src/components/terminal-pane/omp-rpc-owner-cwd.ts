import type { PaneCwdMap } from './resolve-split-cwd'

export function resolveOmpRpcOwnerCwd(args: {
  paneId: number
  paneCwdMap: PaneCwdMap
  fallbackCwd: string | null
}): string | null {
  return args.paneCwdMap.get(args.paneId)?.cwd ?? args.fallbackCwd
}
