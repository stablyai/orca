// Why a marker: the translated sentence decides where the chat name goes, and the name itself is the
// person's own text, so it is placed as a node, never parsed as markup.
const CHAT_MARKER = ''

/**
 * `sentence` (translated with `CHAT_MARKER` as its chat) with the chat name in its own span: it
 * truncates so the notice stays one line, and the full name is its tooltip.
 */
export function nativeChatHeldElsewhereSentence(
  word: (chat: string) => string,
  label: string
): { text: string; content: React.ReactNode } {
  const [before, ...after] = word(CHAT_MARKER).split(CHAT_MARKER)
  return {
    text: word(label),
    content: (
      <>
        {before}
        <span
          title={label}
          className="inline-block max-w-[12ch] truncate align-bottom @[30rem]/notice:max-w-[32ch]"
        >
          {label}
        </span>
        {after.join(label)}
      </>
    )
  }
}
