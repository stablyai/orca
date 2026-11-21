// The description that made a picture, kept so its caption can show it: in memory by the picture's
// PNG until it is saved, then in settings by the bot's saved avatar, so it survives a restart.
import { useAppStore } from '@/store'

/** Pictures made this session, newest last; a picture applied later finds its description here. */
const made = new Map<string, string>()
const MAX_MADE = 20
const MAX_SAVED = 100

export function rememberGeneratedPicture(png: string, description: string): void {
  made.delete(png)
  made.set(png, description)
  const oldest = made.keys().next()
  if (made.size > MAX_MADE && !oldest.done) {
    made.delete(oldest.value)
  }
}

/** The description that made this PNG, if it was generated this session. */
export function generatedPictureDescription(png: string | null | undefined): string | null {
  return png ? (made.get(png) ?? null) : null
}

type SavedPictureOwner = { id: string; hostId?: string | null; avatar: string | null }

function savedKey(owner: SavedPictureOwner): string | null {
  return owner.avatar ? `${owner.hostId ?? 'local'}|${owner.id}|${owner.avatar}` : null
}

// Each save reads the record once the one before it has published, so two quick saves keep both.
let saving: Promise<void> = Promise.resolve()
// Captions queued but not yet published, so a picture put back meanwhile still finds its own.
const queued = new Map<string, string>()

/** The description saved with an avatar, read outside render. */
export function savedPictureDescription(owner: SavedPictureOwner): string | null {
  const key = savedKey(owner)
  if (!key) {
    return null
  }
  return (
    queued.get(key) ?? useAppStore.getState().settings?.generatedAvatarDescriptions?.[key] ?? null
  )
}

/** After `png` is saved as the owner's avatar: keeps its description, when it was generated. A picture
 *  put back (Undo) brings the description saved with its earlier avatar as `known`; a generated picture
 *  saved later brings its own and `prefer: 'known'`, since this session's record of it may be gone. */
export function keepSavedPictureDescription(
  owner: SavedPictureOwner,
  png: string,
  known: string | null = null,
  { prefer = 'made' }: { prefer?: 'made' | 'known' } = {}
): void {
  const description =
    prefer === 'known' ? (known ?? generatedPictureDescription(png)) : (generatedPictureDescription(png) ?? known)
  const key = savedKey(owner)
  if (!description || !key) {
    return
  }
  queued.set(key, description)
  saving = saving.then(async () => {
    const { settings, updateSettingsOrThrow } = useAppStore.getState()
    if (!settings) {
      return
    }
    const entries = Object.entries(settings.generatedAvatarDescriptions ?? {}).filter(
      ([saved]) => saved !== key
    )
    // Newest last; the oldest go once there are more than the cap.
    const kept = [...entries, [key, description] as const].slice(-MAX_SAVED)
    try {
      await updateSettingsOrThrow({ generatedAvatarDescriptions: Object.fromEntries(kept) })
    } catch {
      // Not saved: the caption stays queued, so this session still finds it.
      return
    }
    if (queued.get(key) === description) {
      queued.delete(key)
    }
  })
}

/** The description saved with the owner's current avatar, if it was generated. */
export function useSavedPictureDescription(owner: SavedPictureOwner): string | null {
  const key = savedKey(owner)
  return useAppStore((store) =>
    key ? (store.settings?.generatedAvatarDescriptions?.[key] ?? null) : null
  )
}
