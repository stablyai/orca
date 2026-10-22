/** The desktop window's catalog feed (sidebarInputs.readCatalog): one domain of per-row entities. */
export const CATALOG_RECORDS_DOMAIN = 'catalogRecords'

/** The `order` entity: each list's entity keys, in the catalog's order. */
export type CatalogRecordsOrder = {
  repos: string[]
  projectGroups: string[]
  projects: string[]
  projectHostSetups: string[]
}
