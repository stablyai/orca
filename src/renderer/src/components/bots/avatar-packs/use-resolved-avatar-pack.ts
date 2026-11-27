import { useAppStore } from '@/store'
import { parseBotAvatar } from '../../../../../shared/bot-avatar'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  resolveAvatarPackCharacterIndex,
  resolveAvatarPackId,
  useAvatarPackCatalog
} from './avatar-pack-catalog'
import type { AvatarAnimationState } from './avatar-pack-types'
import { useBotAnimationState } from './use-bot-animation-state'

function hashBotId(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export type ResolvedAvatarPack = {
  active: boolean
  pack: string
  charIndex: number
  state: AvatarAnimationState
}

export function useResolvedAvatarPack(bot: {
  id: string
  avatar?: string | null
  hostId?: ExecutionHostId
  paused?: boolean
  folderWorkspaceId?: string | null
}): ResolvedAvatarPack | null {
  const settings = useAppStore((s) => s.settings)
  const packsEnabled = settings?.avatarPacksEnabled ?? false
  const defaultPack = settings?.avatarDefaultPack

  const parsed = parseBotAvatar(bot.avatar ?? null)
  const wantsPack = parsed?.kind === 'avatar-pack' || (packsEnabled && parsed?.kind !== 'upload')
  const { catalog } = useAvatarPackCatalog(wantsPack)
  const state = useBotAnimationState(bot, wantsPack)

  if (parsed?.kind === 'avatar-pack') {
    if (!catalog || !catalog[parsed.pack]) {
      return null
    }
    return {
      active: true,
      pack: parsed.pack,
      charIndex: resolveAvatarPackCharacterIndex(catalog, parsed.pack, parsed.charIndex),
      state
    }
  }

  if (packsEnabled && parsed?.kind !== 'upload' && catalog) {
    const pack = resolveAvatarPackId(catalog, defaultPack)
    if (!pack) {
      return null
    }
    return {
      active: true,
      pack,
      charIndex: resolveAvatarPackCharacterIndex(catalog, pack, hashBotId(bot.id)),
      state
    }
  }

  return null
}
