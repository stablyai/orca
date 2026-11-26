// SOUL.md: who a bot is. Seeded with a starter line the owner replaces; its first paragraph describes the bot.

export function starterSoul(name: string): string {
  return `# ${name}\n\nDescribe ${name} here: what it is for, how it talks, and what it must never do.\n`
}

const STARTER_LINE = /^Describe .+ here: what it is for, how it talks, and what it must never do\.$/

// Its paragraphs, each on one line.
const paragraphsOf = (soul: string): string[] =>
  soul
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)

/** The first paragraph that isn't a heading, or null while there is none or it is the starter line. */
export function soulDescription(soul: string): string | null {
  // The starter line keeps the name the bot was created with, so a renamed bot's is matched by shape.
  const paragraph = paragraphsOf(soul).find((entry) => !entry.startsWith('#'))
  return paragraph && !STARTER_LINE.test(paragraph) ? paragraph : null
}
