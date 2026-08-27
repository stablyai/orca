/** Renderer breadcrumb carrying the dispatch stack of a same-flush store write
 *  chain captured before react-dom's nested-update limit throws (#185). Shared
 *  so the main-process breadcrumb router can coalesce storms by name. */
export const STORE_WRITE_CHAIN_BREADCRUMB = 'store_write_chain_depth'
