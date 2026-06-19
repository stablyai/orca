import { cn } from '@/lib/utils'
import type { GlobalSettings } from '../../../../shared/types'

export function ChromePreview({ variant }: { variant: GlobalSettings['theme'] }) {
  if (variant === 'system') {
    return (
      <div className="relative size-full">
        <div
          className="absolute inset-0"
          style={{ clipPath: 'polygon(0 0, 50% 0, 50% 100%, 0 100%)' }}
        >
          <ChromeMock dark />
        </div>
        <div
          className="absolute inset-0"
          style={{ clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 50% 100%)' }}
        >
          <ChromeMock dark={false} />
        </div>
        <div
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70"
        />
      </div>
    )
  }
  return <ChromeMock dark={variant === 'dark'} />
}

function ChromeMock({ dark }: { dark: boolean }) {
  // Tiny Orca chrome: sidebar with two rows + a content area with a tab and
  // a composer line. Pure Tailwind so it stays lightweight inside the tile.
  const bg = dark ? 'bg-[#0f1115]' : 'bg-[#f7f8fa]'
  const sidebar = dark ? 'bg-[#16181d]' : 'bg-[#eceef2]'
  const sidebarBorder = dark ? 'border-white/5' : 'border-black/5'
  const row = dark ? 'bg-white/10' : 'bg-black/10'
  const rowDim = dark ? 'bg-white/5' : 'bg-black/5'
  const tab = dark ? 'bg-[#1d2026] border-white/5' : 'bg-white border-black/5'
  const accent = 'bg-violet-500/80'
  return (
    <div className={cn('flex size-full', bg)}>
      <div className={cn('flex w-[34%] flex-col gap-1 border-r p-1.5', sidebar, sidebarBorder)}>
        <div className={cn('h-1 w-7 rounded-sm', rowDim)} />
        <div className="mt-0.5 flex items-center gap-1">
          <span className={cn('size-1 rounded-full', accent)} />
          <span className={cn('h-1 flex-1 rounded-sm', row)} />
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('size-1 rounded-full', rowDim)} />
          <span className={cn('h-1 flex-1 rounded-sm', rowDim)} />
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('size-1 rounded-full', rowDim)} />
          <span className={cn('h-1 w-3/4 rounded-sm', rowDim)} />
        </div>
      </div>
      <div className="flex flex-1 flex-col p-1.5">
        <div className="flex gap-1">
          <div className={cn('h-2 w-8 rounded-sm border', tab)} />
          <div className={cn('h-2 w-5 rounded-sm', rowDim)} />
        </div>
        <div className="mt-1.5 flex-1 space-y-1">
          <div className={cn('h-1 w-full rounded-sm', rowDim)} />
          <div className={cn('h-1 w-5/6 rounded-sm', rowDim)} />
          <div className={cn('h-1 w-2/3 rounded-sm', rowDim)} />
        </div>
        <div className={cn('mt-1 flex h-2.5 items-center gap-1 rounded-sm border px-1', tab)}>
          <span className={cn('size-1 rounded-full', accent)} />
          <span className={cn('h-0.5 flex-1 rounded-sm', rowDim)} />
        </div>
      </div>
    </div>
  )
}
