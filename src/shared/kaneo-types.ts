export type KaneoTaskLink = {
  siteUrl: string
  workspaceId: string
  projectId: string
  taskId: string
  url: string
}

export type KaneoTask = KaneoTaskLink & {
  title: string
  description: string
  number: number
  status: string
}

export type KaneoConnectionStatus = {
  connected: boolean
  siteUrl: string | null
}

export type KaneoConnectArgs = { siteUrl: string; apiKey: string }

export type KaneoApi = {
  status(): Promise<KaneoConnectionStatus>
  connect(args: KaneoConnectArgs): Promise<KaneoConnectionStatus>
  disconnect(): Promise<void>
  getTask(args: { url: string; requestId?: string }): Promise<KaneoTask>
}

export type KaneoDesktopApi = KaneoApi & { cancelTask(args: { requestId: string }): Promise<void> }
