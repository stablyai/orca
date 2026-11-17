import type { BrowserPageDocLocation } from '../../../../../shared/browser/workspaces/browser-workspace-types'

/** The file a reused page must show fresh: a local page's file URL, or a doc-preview's document. */
export type ChangedFilePageRefreshResource =
  | { kind: 'local-file'; url: string }
  | { kind: 'document'; docLocation: BrowserPageDocLocation }

/** One explicit reopen of a page; a newer request for the page replaces it. */
export type ChangedFilePageRefreshIntent = {
  seq: number
  /** performance.now() at request time, comparable with guest registration times. */
  requestedAt: number
  resource: ChangedFilePageRefreshResource
  /** The page's navigation count once main had delivered every guest event sent before the request;
   *  unset until that round trip returns, and the owner does not act before it. */
  baselineSeq?: number
}
