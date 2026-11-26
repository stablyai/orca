export const UNNAMED_BOT_NAME = 'New bot'

/** `requested`, or with none "New bot", else the first free "New bot 2", "New bot 3"… among `bots`. */
export function newBotName(requested: string, bots: readonly { name: string }[]): string {
  if (requested.trim()) {
    return requested.trim()
  }
  const used = new Set(bots.map((bot) => bot.name.toLowerCase()))
  let name = UNNAMED_BOT_NAME
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    name = `${UNNAMED_BOT_NAME} ${n}`
  }
  return name
}
