export type RuntimeBrowserServerPlacement = Readonly<{ kind: 'server' }>

export type RuntimeBrowserClientPlacement = Readonly<{
  kind: 'client'
  browserHostClientId: string
  browserHostGeneration: number
  pageHostGeneration: number
}>

export type RuntimeBrowserPlacement = RuntimeBrowserServerPlacement | RuntimeBrowserClientPlacement

export function sameRuntimeBrowserPlacement(
  left: RuntimeBrowserPlacement,
  right: RuntimeBrowserPlacement
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'server' ||
      (right.kind === 'client' &&
        left.browserHostClientId === right.browserHostClientId &&
        left.browserHostGeneration === right.browserHostGeneration &&
        left.pageHostGeneration === right.pageHostGeneration))
  )
}
