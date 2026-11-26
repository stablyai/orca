// Bot cards share their English copy; each platform passes a `say` that translates an id under its own key.

export type BotCardCopyValues = Record<string, string | number>

export type BotCardSay<Id extends string> = (id: Id, values?: BotCardCopyValues) => string
