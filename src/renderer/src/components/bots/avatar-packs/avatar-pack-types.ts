export type AvatarAnimationState =
  | 'idle'
  | 'think'
  | 'run'
  | 'read'
  | 'edit'
  | 'help'
  | 'done'
  | 'asleep'
  | 'dizzy'

export type AvatarPackVariant = {
  variant: number
  file: string
}

export type AvatarPackCharacterStates = Record<string, AvatarPackVariant[]>

export type AvatarPackManifest = {
  v: number
  id: string
  name?: string
  version: number
  minApp: string
  rig: string
  bodyFill: number
  characters: {
    name?: string
    body: number[]
    temperament: number | null
  }[]
}

export type AvatarPackCatalogEntry = {
  manifest: AvatarPackManifest
  characters: Record<string, AvatarPackCharacterStates>
}

export type AvatarPackCatalogIndex = Record<string, AvatarPackCatalogEntry>

export type AvatarKeyframedNode = {
  id: string
  tag: string
  parent: string | null
  slot: number
  attrs?: Record<string, string>
  props?: Record<string, unknown>
  tracks?: Record<
    string,
    {
      discrete?: boolean
      times: number[]
      values: (number | string | number[])[]
    }
  >
}

export type AvatarKeyframedAnimation = {
  version: number
  pack: string
  index: number
  state: string
  variant: number
  name: string
  duration: number
  once: boolean
  vb: [number, number, number, number]
  nodes: AvatarKeyframedNode[]
}
