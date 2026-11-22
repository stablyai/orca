export function tokenize(line: string): string {
  const KW =
    /\b(?:const|let|await|function|return|if|else|for|of|in|try|catch|throw|new|export|import|from)\b/g
  const STR = /(`[^`]*`|"[^"]*"|'[^']*')/g
  let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(STR, (m) => `<span class="ravs-tok-str">${m}</span>`)
  html = html.replace(KW, (m) => `<span class="ravs-tok-kw">${m}</span>`)
  html = html.replace(/(\b[A-Za-z_]\w*\b)(?=\()/g, (m) => `<span class="ravs-tok-id">${m}</span>`)
  return html
}
