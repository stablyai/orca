/** A read asked for more (Show more) and that part failed; what the rest of it read, `landed`, stands. */
export class BotReadMoreFailed<T> extends Error {
  constructor(readonly landed: T) {
    super('Reading more failed')
  }
}
