export type BusinessmapDomain = 'businessmap.io' | 'kanbanize.com'

export type BusinessmapSite = {
  id: string
  subdomain: string
  domain: BusinessmapDomain
  displayName?: string
  accountName?: string
}

export type BusinessmapViewer = {
  displayName: string
  subdomain: string
}

export type BusinessmapConnectionStatus = {
  connected: boolean
  viewer: BusinessmapViewer | null
  sites?: BusinessmapSite[]
  activeSiteId?: string | null
  selectedSiteId?: string | null
  // Set when a stored API key was rejected but the site stays saved.
  credentialError?: string
}

export type BusinessmapBoard = {
  id: number
  name: string
}

export type BusinessmapCard = {
  id: number
  boardId: number
  title: string
  description?: string
  url: string
  column: { id: number; name: string }
  lane?: { id: number; name: string }
  workflowId: number
  labels: string[]
  assignee?: { id: number; displayName: string }
  updatedAt: string
  createdAt?: string
}

export type BusinessmapComment = {
  id: number
  body: string
  createdAt: string
  user?: { displayName: string }
}

export type BusinessmapConnectArgs = {
  subdomain: string
  apiKey: string
  domain?: BusinessmapDomain
}

export type BusinessmapCardFilter = 'assigned' | 'all' | 'done'

export type BusinessmapCreateCardArgs = {
  boardId: number
  title: string
  description?: string
  columnId?: number
  laneId?: number
}

export type BusinessmapCardUpdate = {
  title?: string
  description?: string
  columnId?: number
  laneId?: number
  reason?: string
}

export type BusinessmapMutationResult = { ok: true } | { ok: false; error: string }

export type BusinessmapCreateCardResult =
  | { ok: true; id: number; url: string }
  | { ok: false; error: string }
