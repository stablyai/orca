import { marked } from 'marked'

export function communityReleaseHighlights(body: string) {
  return marked
    .lexer(body)
    .flatMap((token) => (token.type === 'list' ? token.items : []))
    .filter((item) => !item.text.startsWith('**Previous release'))
    .map((item) => {
      const bold = item.text.match(/^[^\p{L}\p{N}]*\*\*(.+?)\*\*[:\s—–-]*(.*)$/su)
      return {
        title: bold?.[1] ?? item.text.split('\n')[0],
        body: bold?.[2] ?? item.text.split('\n').slice(1).join('\n'),
        prs: [
          ...new Set(
            [...item.text.matchAll(/(?:#|github\.com\/stablyai\/orca\/pull\/)(\d+)/g)].map(
              (match) => Number(match[1])
            )
          )
        ].filter((number) => Number.isSafeInteger(number) && number > 0)
      }
    })
    .slice(0, 6)
}
