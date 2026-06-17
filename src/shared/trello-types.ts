export type TrelloViewer = {
  id: string
  username: string
  displayName: string
  avatarUrl?: string
}

export type TrelloConnectionStatus = {
  connected: boolean
  viewer: TrelloViewer | null
}

export type TrelloBoard = {
  id: string
  name: string
  url: string
  shortUrl: string
}

export type TrelloList = {
  id: string
  name: string
  idBoard: string
  pos: number
  closed: boolean
}

export type TrelloCard = {
  id: string
  shortId: string
  shortLink: string
  name: string
  desc: string
  url: string
  shortUrl: string
  closed: boolean
  dueComplete: boolean
  due: string | null
  idBoard: string
  idList: string
  boardName?: string
  listName?: string
  labels: TrelloLabel[]
  members: TrelloMember[]
  dateLastActivity: string
}

export type TrelloLabel = {
  id: string
  name: string
  color: string | null
}

export type TrelloMember = {
  id: string
  username: string
  fullName: string
  avatarUrl?: string | null
}

export type TrelloComment = {
  id: string
  text: string
  date: string
  dateLastEdited?: string | null
  memberCreator?: TrelloMember
}

export type TrelloCardFilter = 'assigned' | 'allOpen' | 'archived'

export type TrelloCardUpdate = {
  name?: string
  desc?: string
  idList?: string | null
  closed?: boolean
  idMembers?: string[]
  idLabels?: string[]
}

export type TrelloConnectArgs = {
  apiKey: string
  token: string
}

export type TrelloCreateCardArgs = {
  idBoard: string
  idList: string
  name: string
  desc?: string
}

export type TrelloAttachment = {
  id: string
  name: string
  fileName: string
  mimeType: string
  url: string
}

export type TrelloUploadAttachmentArgs = {
  cardId: string
  name: string
  mimeType: string
  contentBase64: string
}

export type TrelloImageDownloadResult =
  | {
      ok: true
      contentType: string
      contentBase64: string
    }
  | {
      ok: false
      error: string
    }
