const TRANSCRIPTION_PATH = '/audio/transcriptions'

/** Accepts a base like `https://api.groq.com/openai/v1` or the full transcriptions URL. */
export function openAiCompatibleTranscriptionUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('Enter a full base URL, such as https://api.groq.com/openai/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The base URL must start with https:// or http://')
  }
  // fetch refuses these, and its error would echo the password.
  if (url.username || url.password) {
    throw new Error('Put the key in the API Key field, not in the base URL')
  }
  // A linear scan: /\/+$/ backtracks quadratically on long slash runs, and this runs per keystroke.
  const pathname = url.pathname
  let end = pathname.length
  while (end > 0 && pathname[end - 1] === '/') {
    end--
  }
  const path = pathname.slice(0, end)
  url.pathname = path.endsWith(TRANSCRIPTION_PATH) ? path : `${path}${TRANSCRIPTION_PATH}`
  return url.toString()
}

/** Whether a saved key may be reused: both base URLs must reach the same valid endpoint. */
export function isSameOpenAiCompatibleEndpoint(savedBaseUrl: string, baseUrl: string): boolean {
  try {
    return (
      openAiCompatibleTranscriptionUrl(savedBaseUrl) === openAiCompatibleTranscriptionUrl(baseUrl)
    )
  } catch {
    return false
  }
}
