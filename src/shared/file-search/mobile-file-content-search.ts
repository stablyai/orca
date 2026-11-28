// Why: earlier hosts refuse `files.search` from phones, so a phone searches file contents only with this.
export const MOBILE_FILE_CONTENT_SEARCH_RUNTIME_CAPABILITY =
  'files.mobile-content-search.v1' as const
