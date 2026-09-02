export type FolderWorkspaceUpdateTicket<TField extends string> = {
  fields: readonly TField[]
  generation: number
  catalogRevision: number
}

export class FolderWorkspaceUpdateCoordinator<TField extends string> {
  private nextGeneration = 0
  private readonly generationByField = new Map<string, number>()
  private readonly catalogRevisionByWorkspaceId = new Map<string, number>()

  begin(folderWorkspaceId: string, fields: readonly TField[]): FolderWorkspaceUpdateTicket<TField> {
    const generation = ++this.nextGeneration
    for (const field of fields) {
      this.generationByField.set(this.fieldKey(folderWorkspaceId, field), generation)
    }
    return {
      fields,
      generation,
      catalogRevision: this.catalogRevisionByWorkspaceId.get(folderWorkspaceId) ?? 0
    }
  }

  latestFields(folderWorkspaceId: string, ticket: FolderWorkspaceUpdateTicket<TField>): TField[] {
    return ticket.fields.filter(
      (field) =>
        this.generationByField.get(this.fieldKey(folderWorkspaceId, field)) === ticket.generation
    )
  }

  catalogChanged(folderWorkspaceId: string, ticket: FolderWorkspaceUpdateTicket<TField>): boolean {
    return (
      (this.catalogRevisionByWorkspaceId.get(folderWorkspaceId) ?? 0) !== ticket.catalogRevision
    )
  }

  finish(folderWorkspaceId: string, ticket: FolderWorkspaceUpdateTicket<TField>): void {
    for (const field of ticket.fields) {
      const key = this.fieldKey(folderWorkspaceId, field)
      if (this.generationByField.get(key) === ticket.generation) {
        this.generationByField.delete(key)
      }
    }
  }

  recordCatalogReplacement(folderWorkspaceIds: Iterable<string>): void {
    for (const folderWorkspaceId of folderWorkspaceIds) {
      this.catalogRevisionByWorkspaceId.set(
        folderWorkspaceId,
        (this.catalogRevisionByWorkspaceId.get(folderWorkspaceId) ?? 0) + 1
      )
    }
  }

  private fieldKey(folderWorkspaceId: string, field: TField): string {
    return `${folderWorkspaceId}\0${field}`
  }
}
