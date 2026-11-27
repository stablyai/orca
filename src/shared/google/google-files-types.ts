// What the Drive, Docs and Sheets commands return over RPC; the CLI prints them, fencing every
// file name and every text someone else wrote.

export type DriveFileSummary = {
  id: string
  name: string
  /** Google's type, e.g. application/vnd.google-apps.document or application/pdf. */
  mimeType: string
  modifiedAt?: number
  size?: number
  owner?: string
  link?: string
}

export type DriveListView = {
  account: string
  /** The folder listed, when it was a folder listing or a search inside one. */
  folder?: { id: string; name: string }
  files: DriveFileSummary[]
  nextPageToken?: string
}

export type DriveReadView = {
  account: string
  file: DriveFileSummary
  /** How the text was made, e.g. "Doc as Markdown" or "PDF text, 12 pages". */
  source: string
  text: string
  /** Set when only part of the text is on this page. */
  part?: { from: number; to: number; of: number }
  nextOffset?: number
}

export type DriveDownload = { file: DriveFileSummary; name: string; data: string }

/** A file a write made or changed, with where it is now. */
export type DriveWriteView = {
  account: string
  file: DriveFileSummary
  /** Orca's words for what happened, e.g. "Moved"; names come separately, as Google has them. */
  done: string
  folder?: { id: string; name: string }
}

export type DocsComment = {
  author: string
  text: string
  /** The doc text the comment is on, when it is anchored. */
  quote?: string
  replies: { author: string; text: string }[]
}

export type DocsReadView = {
  account: string
  id: string
  title: string
  link: string
  text: string
  part?: { from: number; to: number; of: number }
  nextOffset?: number
  /** Open suggestions in the text, marked inline as [+inserted+] and [-deleted-]. */
  suggestions: number
  /** Open comments, on the first page only; resolved ones are left out. */
  comments: DocsComment[]
  /** How many open comments the doc has, shown or not. */
  openComments: number
  /** Set when Orca stopped paging the comment list (a long one, or on a later page), so openComments is a lower bound. */
  moreComments?: boolean
}

export type DocsWriteView = {
  account: string
  id: string
  title: string
  link: string
  done: string
  folder?: { id: string; name: string }
}

export type SheetsTab = { title: string; rows: number; columns: number }

export type SheetsReadView = {
  account: string
  id: string
  title: string
  link: string
  tabs: SheetsTab[]
  /** The range read, in A1 form with its tab, as Google names it. */
  range: string
  /** Rows as Google shows them (formatted values); a short row has empty cells after it. */
  values: string[][]
  /** First row and column of `values`, so cells can be named. */
  origin: { row: number; column: number }
  /** Set when rows were held back to keep one answer bounded: the next range to read. */
  nextRange?: string
}

export type SheetsWriteView = {
  account: string
  id: string
  title: string
  link: string
  done: string
  /** The cells written, in A1 form. */
  ranges: string[]
}
