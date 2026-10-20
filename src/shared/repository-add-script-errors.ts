/** The request never left this client: routing or capability refused it before any send. */
export class RepositoryAddScriptNotSentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryAddScriptNotSentError'
  }
}
