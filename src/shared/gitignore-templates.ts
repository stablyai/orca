export type GitignoreTemplateMetadata = {
  name: string
  filename: string
}

export type GitignoreTemplateCatalogResult = {
  templates: GitignoreTemplateMetadata[]
  stale: boolean
}

export type GitignoreTemplateResult = {
  template: GitignoreTemplateMetadata
  content: string
  stale: boolean
}

export type GitignoreTemplateCache = {
  catalog?: { fetchedAt: number; templates: GitignoreTemplateMetadata[] }
  templates: Record<string, { fetchedAt: number; content: string }>
}
